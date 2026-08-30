const RATE_SCALE = 1_000_000;
const BASIS_POINTS = 10_000;

export interface AccountScaleOutPlannerInput {
  observedAt: number;
  observedAllocatedAccountCount: number;
  observedSuccessfulAllocationCount: number;
  previousObservedAt: number | null;
  previousSuccessfulAllocationCount: number | null;
  previousEwmaRateMicroaccountsPerSecond: number | null;
  forecastHorizonSeconds: number;
  ewmaAlphaBps: number;
  headroomBps: number;
  targetAccountCountPerUnit: number;
  rawCapacityAccountCount: number;
  capacityUnitCount: number;
}

export interface AccountScaleOutPlan {
  sampleIntervalSeconds: number;
  sampleRateMicroaccountsPerSecond: number;
  ewmaRateMicroaccountsPerSecond: number;
  forecastNewAccountCount: number;
  projectedAccountCount: number;
  usableCapacityAccountCount: number;
  capacityUnitCount: number;
  additionalUnitsRequired: number;
  shouldProvision: boolean;
  hasRateSample: boolean;
}

function safeInteger(value: number, minimum: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(code);
  return value;
}

function safeProduct(left: number, right: number, code: string): number {
  return safeInteger(left * right, 0, code);
}

function ceilDivide(numerator: number, denominator: number, code: string): number {
  safeInteger(numerator, 0, code);
  safeInteger(denominator, 1, code);
  return Math.floor(numerator / denominator) + (numerator % denominator === 0 ? 0 : 1);
}

/** Pure deterministic Core/PII growth planner using integer microaccounts per second. */
export function planAccountScaleOut(input: AccountScaleOutPlannerInput): AccountScaleOutPlan {
  const observedAt = safeInteger(input.observedAt, 1, 'account_scale_out_observation_invalid');
  const observedAllocatedAccountCount = safeInteger(
    input.observedAllocatedAccountCount,
    0,
    'account_scale_out_observation_invalid'
  );
  const observedSuccessfulAllocationCount = safeInteger(
    input.observedSuccessfulAllocationCount,
    0,
    'account_scale_out_observation_invalid'
  );
  const horizon = safeInteger(input.forecastHorizonSeconds, 60, 'account_scale_out_policy_invalid');
  if (horizon > 2_592_000) throw new Error('account_scale_out_policy_invalid');
  const alpha = safeInteger(input.ewmaAlphaBps, 1, 'account_scale_out_policy_invalid');
  if (alpha > BASIS_POINTS) throw new Error('account_scale_out_policy_invalid');
  const headroom = safeInteger(input.headroomBps, 0, 'account_scale_out_policy_invalid');
  if (headroom > 9_000) throw new Error('account_scale_out_policy_invalid');
  const targetAccountCountPerUnit = safeInteger(
    input.targetAccountCountPerUnit,
    1,
    'account_scale_out_capacity_invalid'
  );
  const rawCapacityAccountCount = safeInteger(
    input.rawCapacityAccountCount,
    0,
    'account_scale_out_capacity_invalid'
  );
  const capacityUnitCount = safeInteger(
    input.capacityUnitCount,
    0,
    'account_scale_out_capacity_invalid'
  );

  let sampleIntervalSeconds = 0;
  let sampleRateMicroaccountsPerSecond = 0;
  let ewmaRateMicroaccountsPerSecond = input.previousEwmaRateMicroaccountsPerSecond ?? 0;
  safeInteger(ewmaRateMicroaccountsPerSecond, 0, 'account_scale_out_observation_invalid');
  let hasRateSample = false;

  if (input.previousObservedAt !== null || input.previousSuccessfulAllocationCount !== null) {
    if (input.previousObservedAt === null || input.previousSuccessfulAllocationCount === null) {
      throw new Error('account_scale_out_observation_invalid');
    }
    const previousObservedAt = safeInteger(
      input.previousObservedAt,
      1,
      'account_scale_out_observation_invalid'
    );
    const previousSuccessfulAllocationCount = safeInteger(
      input.previousSuccessfulAllocationCount,
      0,
      'account_scale_out_observation_invalid'
    );
    if (observedAt < previousObservedAt) throw new Error('account_scale_out_observation_stale');
    if (observedSuccessfulAllocationCount < previousSuccessfulAllocationCount) {
      throw new Error('account_scale_out_allocation_counter_decreased');
    }
    sampleIntervalSeconds = observedAt - previousObservedAt;
    if (sampleIntervalSeconds > 0) {
      const growth = observedSuccessfulAllocationCount - previousSuccessfulAllocationCount;
      sampleRateMicroaccountsPerSecond = Math.floor(
        safeProduct(growth, RATE_SCALE, 'account_scale_out_observation_overflow') /
          sampleIntervalSeconds
      );
      const weightedSample = safeProduct(
        sampleRateMicroaccountsPerSecond,
        alpha,
        'account_scale_out_observation_overflow'
      );
      const weightedPrevious = safeProduct(
        ewmaRateMicroaccountsPerSecond,
        BASIS_POINTS - alpha,
        'account_scale_out_observation_overflow'
      );
      ewmaRateMicroaccountsPerSecond = Math.floor(
        safeInteger(
          weightedSample + weightedPrevious + BASIS_POINTS / 2,
          0,
          'account_scale_out_observation_overflow'
        ) / BASIS_POINTS
      );
      hasRateSample = true;
    }
  }

  const forecastNewAccountCount = ceilDivide(
    safeProduct(ewmaRateMicroaccountsPerSecond, horizon, 'account_scale_out_forecast_overflow'),
    RATE_SCALE,
    'account_scale_out_forecast_overflow'
  );
  const projectedAccountCount = safeInteger(
    observedAllocatedAccountCount + forecastNewAccountCount,
    0,
    'account_scale_out_forecast_overflow'
  );
  const usableCapacityAccountCount = Math.floor(
    safeProduct(
      rawCapacityAccountCount,
      BASIS_POINTS - headroom,
      'account_scale_out_capacity_invalid'
    ) / BASIS_POINTS
  );
  const usablePerUnit = Math.floor(
    safeProduct(
      targetAccountCountPerUnit,
      BASIS_POINTS - headroom,
      'account_scale_out_capacity_invalid'
    ) / BASIS_POINTS
  );
  if (usablePerUnit < 1) throw new Error('account_scale_out_policy_invalid');
  const deficit = Math.max(0, projectedAccountCount - usableCapacityAccountCount);
  const additionalUnitsRequired =
    deficit === 0 ? 0 : ceilDivide(deficit, usablePerUnit, 'account_scale_out_capacity_invalid');

  return {
    sampleIntervalSeconds,
    sampleRateMicroaccountsPerSecond,
    ewmaRateMicroaccountsPerSecond,
    forecastNewAccountCount,
    projectedAccountCount,
    usableCapacityAccountCount,
    capacityUnitCount,
    additionalUnitsRequired,
    shouldProvision: additionalUnitsRequired > 0,
    hasRateSample,
  };
}
