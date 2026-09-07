import {
  PHASE1_SCHEMA_VERSION,
  type Phase1Baseline,
  type Phase1ControlSnapshot,
  type Phase1HarnessConfig,
  type Phase1ProviderSnapshot,
} from './schemas.js';

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

function text(row: Record<string, unknown> | null, key: string): string | null {
  return typeof row?.[key] === 'string' ? row[key] : null;
}

function number(row: Record<string, unknown> | null, key: string): number | null {
  const value = row?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function display(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : 'missing';
}

function check(checks: Check[], name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

function calculateRoleCreates(
  snapshot: Phase1ControlSnapshot,
  role: 'tenant_core/users' | 'tenant_pii',
  accountCount: number,
  target: number,
  config: Phase1HarnessConfig
): number {
  const shards = snapshot.shardCapacities.filter(
    (row) =>
      row.data_role === role &&
      row.allocation_scope === config.environment.placementPolicy &&
      (config.environment.placementPolicy === 'shared_pool'
        ? row.owner_tenant_id === null
        : row.owner_tenant_id === config.environment.tenantId) &&
      row.status !== 'deleted'
  );
  const allocated = shards.reduce(
    (sum, row) =>
      sum + (typeof row.allocated_account_count === 'number' ? row.allocated_account_count : 0),
    0
  );
  const requiredUnits = Math.ceil((allocated + accountCount) / target);
  return Math.max(0, requiredUnits - shards.length);
}

export function evaluatePhase1Preflight(input: {
  config: Phase1HarnessConfig;
  control: Phase1ControlSnapshot;
  provider: Phase1ProviderSnapshot;
  runId: string;
  now?: Date;
}): Phase1Baseline {
  const checks: Check[] = [];
  const { config, control, provider } = input;
  const now = input.now ?? new Date();
  const manualEpoch = Date.parse(config.attestations.noManualInterventionFrom);
  const manualEpochSeconds = Math.floor(manualEpoch / 1_000);
  const environment = control.environment;
  const policy = control.resourcePolicy;
  const tenant = control.tenantPolicy;

  check(
    checks,
    'disposable_environment',
    config.environment.disposable === true,
    config.environment.environmentId
  );
  check(
    checks,
    'environment_active',
    text(environment, 'environment_id') === config.environment.environmentId &&
      text(environment, 'lifecycle_state') === 'active',
    `${text(environment, 'environment_id') ?? 'missing'}:${text(environment, 'lifecycle_state') ?? 'missing'}`
  );
  check(
    checks,
    'environment_resource_prefix_available',
    (text(environment, 'environment_name')?.length ?? 0) > 0,
    text(environment, 'environment_name') ?? 'missing'
  );
  check(
    checks,
    'automatic_provisioning_ready',
    number(environment, 'automatic_provisioning_enabled') === 1 &&
      text(environment, 'provisioning_capability_state') === 'ready' &&
      ['account', 'user'].includes(text(environment, 'provisioning_token_ownership') ?? ''),
    `${number(environment, 'automatic_provisioning_enabled') ?? 'missing'}:${text(environment, 'provisioning_capability_state') ?? 'missing'}:${text(environment, 'provisioning_token_ownership') ?? 'missing'}`
  );
  check(
    checks,
    'tenant_placement_active',
    text(tenant, 'tenant_id') === config.environment.tenantId &&
      text(tenant, 'isolation_policy') === config.environment.placementPolicy &&
      text(tenant, 'policy_state') === 'active',
    `${text(tenant, 'tenant_id') ?? 'missing'}:${text(tenant, 'isolation_policy') ?? 'missing'}:${text(tenant, 'policy_state') ?? 'missing'}`
  );
  check(
    checks,
    'selected_tenant_is_active',
    (number(environment, 'active_tenant_count') ?? 0) >= 1,
    String(number(environment, 'active_tenant_count') ?? 'missing')
  );
  const allocationSummary =
    control.tenantAllocations.find((row) => row.row_kind === 'summary') ?? null;
  check(
    checks,
    'clean_tenant_allocation_baseline',
    number(allocationSummary, 'allocation_count') === 0,
    String(number(allocationSummary, 'allocation_count') ?? 'missing')
  );

  for (const role of ['tenant_core/users', 'tenant_pii'] as const) {
    const active = control.tenantAssignments.filter(
      (row) => row.data_role === role && row.assignment_state === 'active'
    );
    check(checks, `${role}_one_active_assignment`, active.length === 1, String(active.length));
    const shard = control.shardCapacities.find((row) => row.shard_id === active[0]?.shard_id);
    check(
      checks,
      `${role}_target_matches`,
      shard?.target_account_count === config.expectedPolicy.targetAccountCount,
      display(shard?.target_account_count)
    );
    check(
      checks,
      `${role}_healthy_and_eligible`,
      shard?.status === 'active' &&
        shard.health_status === 'healthy' &&
        shard.allocation_status === 'eligible',
      `${display(shard?.status)}:${display(shard?.health_status)}:${display(shard?.allocation_status)}`
    );
  }

  const nonTerminalOperations = control.operations.filter((row) => {
    if (['queued', 'running', 'waiting_retry'].includes(String(row.status))) return true;
    return (
      row.status === 'blocked' &&
      typeof row.updated_at === 'number' &&
      row.updated_at >= manualEpochSeconds
    );
  });
  check(
    checks,
    'no_nonterminal_control_operations',
    nonTerminalOperations.length === 0,
    String(nonTerminalOperations.length)
  );
  check(
    checks,
    'no_worker_binding_drift',
    control.workerBindingDrift.length === 0,
    String(control.workerBindingDrift.length)
  );

  const expected = config.expectedPolicy;
  const policyMatches =
    number(policy, 'target_account_count') === expected.targetAccountCount &&
    number(policy, 'max_concurrent_provisioning') === expected.maxConcurrentProvisioning &&
    number(policy, 'max_ready_spares') === expected.maxReadySpares &&
    number(policy, 'max_d1_resources') === expected.maxD1Resources &&
    number(policy, 'daily_d1_create_budget') === expected.dailyD1CreateBudget &&
    number(policy, 'lookup_target_active_route_count') === expected.lookupTargetActiveRouteCount &&
    number(policy, 'lookup_forecast_horizon_seconds') === expected.lookupForecastHorizonSeconds &&
    number(policy, 'lookup_registration_ewma_alpha_bps') === expected.lookupEwmaAlphaBps &&
    number(policy, 'lookup_scale_out_headroom_bps') === expected.lookupHeadroomBps &&
    number(policy, 'lookup_scale_out_policy_generation') === expected.lookupPolicyGeneration &&
    number(policy, 'account_forecast_horizon_seconds') === expected.accountForecastHorizonSeconds &&
    number(policy, 'account_registration_ewma_alpha_bps') === expected.accountEwmaAlphaBps &&
    number(policy, 'account_scale_out_headroom_bps') === expected.accountHeadroomBps &&
    number(policy, 'account_scale_out_policy_generation') === expected.accountPolicyGeneration;
  check(
    checks,
    'resource_policy_exact_match',
    policyMatches,
    policyMatches ? 'matched' : 'mismatch'
  );

  const activeResidencies = control.residencyPartitions.filter((row) => row.status === 'active');
  const missingDomains = activeResidencies.filter(
    (row) =>
      typeof row.lookup_capacity_domain_id !== 'string' || row.lookup_capacity_domain_id === ''
  );
  check(
    checks,
    'lookup_capacity_domains_explicit',
    missingDomains.length === 0,
    String(missingDomains.length)
  );
  const domainPlacement = new Map<string, Set<string>>();
  for (const row of activeResidencies) {
    if (typeof row.lookup_capacity_domain_id !== 'string') continue;
    const placements = domainPlacement.get(row.lookup_capacity_domain_id) ?? new Set<string>();
    placements.add(
      `${display(row.residency_partition)}:${display(row.jurisdiction)}:${display(row.location_hint)}`
    );
    domainPlacement.set(row.lookup_capacity_domain_id, placements);
  }
  const incompatibleDomains = [...domainPlacement.values()].filter(
    (placements) => placements.size > 1
  );
  check(
    checks,
    'lookup_capacity_domain_placement_compatible',
    incompatibleDomains.length === 0,
    String(incompatibleDomains.length)
  );
  const unexpectedLookupWeights = control.lookupShards.filter((row) => row.capacity_weight !== 1);
  check(
    checks,
    'lookup_capacity_weights_standard',
    unexpectedLookupWeights.length === 0,
    String(unexpectedLookupWeights.length)
  );
  const activeLookupAssignments = control.lookupAssignments.filter((row) => row.state === 'active');
  const lookupBuckets = new Set(
    activeLookupAssignments.flatMap((row) =>
      Number.isSafeInteger(row.virtual_bucket) ? [Number(row.virtual_bucket)] : []
    )
  );
  check(
    checks,
    'lookup_assignment_coverage',
    activeLookupAssignments.length === 4_096 &&
      lookupBuckets.size === 4_096 &&
      [...lookupBuckets].every((bucket) => bucket >= 0 && bucket <= 4_095),
    `${activeLookupAssignments.length}:${lookupBuckets.size}`
  );

  const triggerEpoch = Date.parse(config.attestations.scheduledTriggerLastSucceededAt);
  const triggerAgeMs = now.getTime() - triggerEpoch;
  check(
    checks,
    'scheduled_trigger_recent',
    triggerAgeMs >= -2_000 && triggerAgeMs <= 15 * 60_000,
    String(triggerAgeMs)
  );
  const manualAgeMs = now.getTime() - manualEpoch;
  check(
    checks,
    'manual_intervention_window_started',
    manualAgeMs >= -2_000 && manualAgeMs <= 15 * 60_000,
    String(manualAgeMs)
  );

  const coreCreates = calculateRoleCreates(
    control,
    'tenant_core/users',
    config.load.accountCount,
    expected.targetAccountCount,
    config
  );
  const piiCreates = calculateRoleCreates(
    control,
    'tenant_pii',
    config.load.accountCount,
    expected.targetAccountCount,
    config
  );
  const existingLookupUnits = control.lookupShards.reduce(
    (sum, row) =>
      sum +
      (['requested', 'provisioning', 'ready', 'active'].includes(String(row.status)) &&
      typeof row.capacity_weight === 'number'
        ? row.capacity_weight
        : 0),
    0
  );
  const usableLookupUnit = Math.floor(
    (expected.lookupTargetActiveRouteCount * (10_000 - expected.lookupHeadroomBps)) / 10_000
  );
  const observedLookupRoutes = control.lookupForecasts.reduce(
    (sum, row) =>
      sum +
      (typeof row.observed_active_route_count === 'number' ? row.observed_active_route_count : 0),
    0
  );
  const currentProjectedLookupRoutes = control.lookupForecasts.reduce(
    (sum, row) =>
      sum +
      (typeof row.projected_active_route_count === 'number' ? row.projected_active_route_count : 0),
    0
  );
  const plannedLookupRoutes = config.load.accountCount * expected.expectedLookupRoutesPerAccount;
  const incomingLookupRoutes =
    config.load.ratePerSecond *
    expected.lookupForecastHorizonSeconds *
    expected.expectedLookupRoutesPerAccount;
  const projectedLookupRoutes = Math.max(
    currentProjectedLookupRoutes,
    observedLookupRoutes + plannedLookupRoutes + incomingLookupRoutes
  );
  const theoreticalLookupUnits = Math.ceil(projectedLookupRoutes / usableLookupUnit);
  const theoreticalLookupAdditions = Math.max(
    0,
    theoreticalLookupUnits - Math.floor(existingLookupUnits)
  );
  check(
    checks,
    'lookup_addition_acceptance_reachable',
    theoreticalLookupAdditions >= expected.minimumLookupAdditions,
    `${theoreticalLookupAdditions}:${expected.minimumLookupAdditions}`
  );

  const expectedMinimumD1Creates = coreCreates + piiCreates + theoreticalLookupAdditions;
  const dailyBudget = number(policy, 'daily_d1_create_budget') ?? -1;
  const dailyBudgetUsed = number(environment, 'daily_d1_create_used') ?? -1;
  const remainingDailyBudget = dailyBudget - dailyBudgetUsed;
  check(
    checks,
    'remaining_daily_d1_create_budget',
    dailyBudget >= 0 &&
      dailyBudgetUsed >= 0 &&
      remainingDailyBudget >= expectedMinimumD1Creates + 2,
    `${remainingDailyBudget}:${expectedMinimumD1Creates + 2}:used=${dailyBudgetUsed}:limit=${dailyBudget}`
  );
  const maxResources = number(policy, 'max_d1_resources') ?? -1;
  const currentEnvironmentResources = number(environment, 'current_environment_d1_count') ?? -1;
  check(
    checks,
    'environment_d1_resource_limit',
    maxResources >= 0 &&
      currentEnvironmentResources >= 0 &&
      maxResources >= currentEnvironmentResources + expectedMinimumD1Creates + 2,
    `${maxResources}:${currentEnvironmentResources + expectedMinimumD1Creates + 2}:current=${currentEnvironmentResources}`
  );

  const providerIds = new Set(provider.databases.map((database) => database.uuid));
  const missingProviderResources = [...control.shardCapacities, ...control.lookupShards].filter(
    (row) =>
      ['active', 'ready'].includes(String(row.status)) &&
      (typeof row.provider_resource_id !== 'string' || !providerIds.has(row.provider_resource_id))
  );
  check(
    checks,
    'control_provider_inventory_matches',
    missingProviderResources.length === 0,
    String(missingProviderResources.length)
  );

  const passed = checks.every((entry) => entry.passed);
  return {
    schemaVersion: PHASE1_SCHEMA_VERSION,
    runId: input.runId,
    capturedAt: now.toISOString(),
    sourceCommit: config.environment.sourceCommit,
    control,
    provider,
    lookupBuckets: [],
    preflight: { passed, checks, expectedMinimumD1Creates },
  };
}
