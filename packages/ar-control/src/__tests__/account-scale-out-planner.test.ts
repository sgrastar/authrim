import { describe, expect, it } from 'vitest';
import { planAccountScaleOut } from '../account-scale-out-planner';

const baseline = {
  observedAt: 1_700_000_600,
  observedAllocatedAccountCount: 70,
  observedSuccessfulAllocationCount: 70,
  previousObservedAt: 1_700_000_000,
  previousSuccessfulAllocationCount: 10,
  previousEwmaRateMicroaccountsPerSecond: 80_000,
  forecastHorizonSeconds: 900,
  ewmaAlphaBps: 2_500,
  headroomBps: 2_000,
  targetAccountCountPerUnit: 100,
  rawCapacityAccountCount: 100,
  capacityUnitCount: 1,
};

describe('planAccountScaleOut', () => {
  it('provisions before forecast growth consumes reserved Core/PII headroom', () => {
    const plan = planAccountScaleOut(baseline);

    expect(plan.sampleRateMicroaccountsPerSecond).toBe(100_000);
    expect(plan.ewmaRateMicroaccountsPerSecond).toBe(85_000);
    expect(plan.forecastNewAccountCount).toBe(77);
    expect(plan.projectedAccountCount).toBe(147);
    expect(plan.usableCapacityAccountCount).toBe(80);
    expect(plan.additionalUnitsRequired).toBe(1);
    expect(plan.shouldProvision).toBe(true);
  });

  it('counts in-flight capacity and avoids duplicate capacity demand', () => {
    const plan = planAccountScaleOut({
      ...baseline,
      rawCapacityAccountCount: 200,
      capacityUnitCount: 2,
    });

    expect(plan.usableCapacityAccountCount).toBe(160);
    expect(plan.additionalUnitsRequired).toBe(0);
    expect(plan.shouldProvision).toBe(false);
  });

  it('fails closed when the exact allocation counter decreases', () => {
    expect(() =>
      planAccountScaleOut({
        ...baseline,
        observedSuccessfulAllocationCount: 9,
      })
    ).toThrow('account_scale_out_allocation_counter_decreased');
  });

  it('warms on the first observation but still reacts after headroom is consumed', () => {
    const plan = planAccountScaleOut({
      ...baseline,
      observedAllocatedAccountCount: 81,
      previousObservedAt: null,
      previousSuccessfulAllocationCount: null,
      previousEwmaRateMicroaccountsPerSecond: null,
    });

    expect(plan.hasRateSample).toBe(false);
    expect(plan.forecastNewAccountCount).toBe(0);
    expect(plan.shouldProvision).toBe(true);
  });

  it('rejects stale observations and invalid headroom rounding', () => {
    expect(() =>
      planAccountScaleOut({
        ...baseline,
        observedAt: baseline.previousObservedAt - 1,
      })
    ).toThrow('account_scale_out_observation_stale');
    expect(() =>
      planAccountScaleOut({
        ...baseline,
        targetAccountCountPerUnit: 1,
        headroomBps: 9_000,
      })
    ).toThrow('account_scale_out_policy_invalid');
  });
});
