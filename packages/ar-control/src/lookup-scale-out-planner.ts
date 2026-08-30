const RATE_SCALE = 1_000_000;
const BASIS_POINTS = 10_000;
const CAPACITY_WEIGHT_SCALE = 1_000;

export interface LookupScaleOutPlannerInput {
  observedAt: number;
  observedActiveRouteCount: number;
  observedSuccessfulPublicationCount: number;
  previousObservedAt: number | null;
  previousSuccessfulPublicationCount: number | null;
  previousEwmaRateMicrorowsPerSecond: number | null;
  forecastHorizonSeconds: number;
  ewmaAlphaBps: number;
  headroomBps: number;
  targetActiveRouteCountPerUnit: number;
  capacityWeightMilliunits: number;
  capacityUnitCount: number;
}

export interface LookupScaleOutPlan {
  sampleIntervalSeconds: number;
  sampleRateMicrorowsPerSecond: number;
  ewmaRateMicrorowsPerSecond: number;
  forecastNewRouteCount: number;
  projectedActiveRouteCount: number;
  usableCapacityRouteCount: number;
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
  const result = left * right;
  return safeInteger(result, 0, code);
}

function ceilDivide(numerator: number, denominator: number, code: string): number {
  safeInteger(numerator, 0, code);
  safeInteger(denominator, 1, code);
  return Math.floor(numerator / denominator) + (numerator % denominator === 0 ? 0 : 1);
}

/** Pure deterministic planner. Rates use integer microrows/second to avoid float drift. */
export function planLookupScaleOut(input: LookupScaleOutPlannerInput): LookupScaleOutPlan {
  const observedAt = safeInteger(input.observedAt, 1, 'lookup_scale_out_observation_invalid');
  const observedActiveRouteCount = safeInteger(
    input.observedActiveRouteCount,
    0,
    'lookup_scale_out_observation_invalid'
  );
  const observedSuccessfulPublicationCount = safeInteger(
    input.observedSuccessfulPublicationCount,
    0,
    'lookup_scale_out_observation_invalid'
  );
  const horizon = safeInteger(input.forecastHorizonSeconds, 300, 'lookup_scale_out_policy_invalid');
  if (horizon > 2_592_000) throw new Error('lookup_scale_out_policy_invalid');
  const alpha = safeInteger(input.ewmaAlphaBps, 1, 'lookup_scale_out_policy_invalid');
  if (alpha > BASIS_POINTS) throw new Error('lookup_scale_out_policy_invalid');
  const headroom = safeInteger(input.headroomBps, 0, 'lookup_scale_out_policy_invalid');
  if (headroom > 9_000) throw new Error('lookup_scale_out_policy_invalid');
  const target = safeInteger(
    input.targetActiveRouteCountPerUnit,
    1,
    'lookup_scale_out_policy_invalid'
  );
  const capacityWeightMilliunits = safeInteger(
    input.capacityWeightMilliunits,
    0,
    'lookup_scale_out_capacity_invalid'
  );
  const capacityUnitCount = safeInteger(
    input.capacityUnitCount,
    0,
    'lookup_scale_out_capacity_invalid'
  );

  let sampleIntervalSeconds = 0;
  let sampleRateMicrorowsPerSecond = 0;
  let ewmaRateMicrorowsPerSecond = input.previousEwmaRateMicrorowsPerSecond ?? 0;
  safeInteger(ewmaRateMicrorowsPerSecond, 0, 'lookup_scale_out_observation_invalid');
  let hasRateSample = false;

  if (input.previousObservedAt !== null || input.previousSuccessfulPublicationCount !== null) {
    if (input.previousObservedAt === null || input.previousSuccessfulPublicationCount === null) {
      throw new Error('lookup_scale_out_observation_invalid');
    }
    const previousObservedAt = safeInteger(
      input.previousObservedAt,
      1,
      'lookup_scale_out_observation_invalid'
    );
    const previousSuccessfulPublicationCount = safeInteger(
      input.previousSuccessfulPublicationCount,
      0,
      'lookup_scale_out_observation_invalid'
    );
    if (observedAt < previousObservedAt) throw new Error('lookup_scale_out_observation_stale');
    if (observedSuccessfulPublicationCount < previousSuccessfulPublicationCount) {
      throw new Error('lookup_scale_out_publication_counter_decreased');
    }
    sampleIntervalSeconds = observedAt - previousObservedAt;
    if (sampleIntervalSeconds > 0) {
      const growth = observedSuccessfulPublicationCount - previousSuccessfulPublicationCount;
      sampleRateMicrorowsPerSecond = Math.floor(
        safeProduct(growth, RATE_SCALE, 'lookup_scale_out_observation_overflow') /
          sampleIntervalSeconds
      );
      const weightedSample = safeProduct(
        sampleRateMicrorowsPerSecond,
        alpha,
        'lookup_scale_out_observation_overflow'
      );
      const weightedPrevious = safeProduct(
        ewmaRateMicrorowsPerSecond,
        BASIS_POINTS - alpha,
        'lookup_scale_out_observation_overflow'
      );
      const weightedTotal = safeInteger(
        weightedSample + weightedPrevious,
        0,
        'lookup_scale_out_observation_overflow'
      );
      ewmaRateMicrorowsPerSecond = Math.floor(
        safeInteger(weightedTotal + BASIS_POINTS / 2, 0, 'lookup_scale_out_observation_overflow') /
          BASIS_POINTS
      );
      hasRateSample = true;
    }
  }

  const forecastNewRouteCount = ceilDivide(
    safeProduct(ewmaRateMicrorowsPerSecond, horizon, 'lookup_scale_out_forecast_overflow'),
    RATE_SCALE,
    'lookup_scale_out_forecast_overflow'
  );
  const projectedActiveRouteCount = safeInteger(
    observedActiveRouteCount + forecastNewRouteCount,
    0,
    'lookup_scale_out_forecast_overflow'
  );
  const usablePerStandardUnit = Math.floor(
    safeProduct(target, BASIS_POINTS - headroom, 'lookup_scale_out_capacity_invalid') / BASIS_POINTS
  );
  if (usablePerStandardUnit < 1) throw new Error('lookup_scale_out_policy_invalid');
  const usableCapacityRouteCount = Math.floor(
    safeProduct(
      usablePerStandardUnit,
      capacityWeightMilliunits,
      'lookup_scale_out_capacity_invalid'
    ) / CAPACITY_WEIGHT_SCALE
  );
  const deficit = Math.max(0, projectedActiveRouteCount - usableCapacityRouteCount);
  const additionalUnitsRequired =
    deficit === 0
      ? 0
      : ceilDivide(deficit, usablePerStandardUnit, 'lookup_scale_out_capacity_invalid');

  return {
    sampleIntervalSeconds,
    sampleRateMicrorowsPerSecond,
    ewmaRateMicrorowsPerSecond,
    forecastNewRouteCount,
    projectedActiveRouteCount,
    usableCapacityRouteCount,
    capacityUnitCount,
    additionalUnitsRequired,
    shouldProvision: additionalUnitsRequired > 0,
    hasRateSample,
  };
}
