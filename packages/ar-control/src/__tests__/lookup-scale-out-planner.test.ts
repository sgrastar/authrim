import { describe, expect, it } from 'vitest';
import { planLookupScaleOut } from '../lookup-scale-out-planner';

const baseline = {
  observedAt: 1_700_000_600,
  observedActiveRouteCount: 70_000,
  observedSuccessfulPublicationCount: 16_000,
  previousObservedAt: 1_700_000_000,
  previousSuccessfulPublicationCount: 10_000,
  previousEwmaRateMicrorowsPerSecond: 8_000_000,
  forecastHorizonSeconds: 3_600,
  ewmaAlphaBps: 2_500,
  headroomBps: 2_000,
  targetActiveRouteCountPerUnit: 100_000,
  capacityWeightMilliunits: 1_000,
  capacityUnitCount: 1,
};

describe('planLookupScaleOut', () => {
  it('provisions before forecast load consumes reserved headroom', () => {
    const plan = planLookupScaleOut(baseline);

    expect(plan.sampleRateMicrorowsPerSecond).toBe(10_000_000);
    expect(plan.ewmaRateMicrorowsPerSecond).toBe(8_500_000);
    expect(plan.forecastNewRouteCount).toBe(30_600);
    expect(plan.projectedActiveRouteCount).toBe(100_600);
    expect(plan.usableCapacityRouteCount).toBe(80_000);
    expect(plan.additionalUnitsRequired).toBe(1);
    expect(plan.shouldProvision).toBe(true);
  });

  it('counts in-flight capacity and avoids duplicate capacity requests', () => {
    const plan = planLookupScaleOut({
      ...baseline,
      capacityWeightMilliunits: 2_000,
      capacityUnitCount: 2,
    });

    expect(plan.usableCapacityRouteCount).toBe(160_000);
    expect(plan.additionalUnitsRequired).toBe(0);
    expect(plan.shouldProvision).toBe(false);
  });

  it('fails closed when a monotonic publication counter decreases', () => {
    expect(() =>
      planLookupScaleOut({
        ...baseline,
        observedSuccessfulPublicationCount: 9_000,
      })
    ).toThrow('lookup_scale_out_publication_counter_decreased');
  });

  it('warms on the first observation while still reacting to exhausted current capacity', () => {
    const plan = planLookupScaleOut({
      ...baseline,
      observedActiveRouteCount: 81_000,
      previousObservedAt: null,
      previousSuccessfulPublicationCount: null,
      previousEwmaRateMicrorowsPerSecond: null,
    });

    expect(plan.hasRateSample).toBe(false);
    expect(plan.forecastNewRouteCount).toBe(0);
    expect(plan.shouldProvision).toBe(true);
  });

  it('fails closed for stale observations', () => {
    expect(() =>
      planLookupScaleOut({
        ...baseline,
        observedAt: baseline.previousObservedAt - 1,
      })
    ).toThrow('lookup_scale_out_observation_stale');
  });

  it('rejects a policy whose headroom rounds usable unit capacity down to zero', () => {
    expect(() =>
      planLookupScaleOut({
        ...baseline,
        targetActiveRouteCountPerUnit: 1,
        headroomBps: 9_000,
      })
    ).toThrow('lookup_scale_out_policy_invalid');
  });
});
