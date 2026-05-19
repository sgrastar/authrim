import { describe, expect, it } from 'vitest';
import { resolveGeneratedLocalCapacityPlan } from '../core/generated-local-capacity';

describe('resolveGeneratedLocalCapacityPlan', () => {
  it('uses a bounded mixed local capacity default', () => {
    expect(resolveGeneratedLocalCapacityPlan({})).toEqual({
      scenario: 'mixed',
      lps: 25,
      durationSeconds: 30,
      maxInFlight: 100,
    });
  });

  it('accepts explicit 100 and 150 LPS local plans', () => {
    expect(
      resolveGeneratedLocalCapacityPlan({
        scenario: 'protected-resource',
        lps: 100,
        durationSeconds: 20,
      })
    ).toMatchObject({
      scenario: 'protected-resource',
      lps: 100,
      durationSeconds: 20,
      maxInFlight: 400,
    });

    expect(
      resolveGeneratedLocalCapacityPlan({
        scenario: 'token-exchange',
        lps: 150,
        durationSeconds: 20,
        maxInFlight: 300,
      })
    ).toMatchObject({
      scenario: 'token-exchange',
      lps: 150,
      maxInFlight: 300,
    });
  });

  it('rejects unbounded local capacity settings', () => {
    expect(() => resolveGeneratedLocalCapacityPlan({ lps: 501 })).toThrow(
      'invalid_local_capacity_lps'
    );
    expect(() => resolveGeneratedLocalCapacityPlan({ durationSeconds: 301 })).toThrow(
      'invalid_local_capacity_duration'
    );
    expect(() => resolveGeneratedLocalCapacityPlan({ maxInFlight: 2001 })).toThrow(
      'invalid_local_capacity_max_in_flight'
    );
  });
});
