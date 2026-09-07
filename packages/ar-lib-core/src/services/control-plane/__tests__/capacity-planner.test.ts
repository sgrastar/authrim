import { describe, expect, it } from 'vitest';
import { planControlCapacity, type ControlCapacityPlannerInput } from '../capacity-planner.js';

function input(overrides: Partial<ControlCapacityPlannerInput> = {}): ControlCapacityPlannerInput {
  return {
    profile: 'recommended',
    scope: 'tenant_exclusive',
    tenantId: 'tenant-1',
    currentEnvironmentD1Count: 10,
    environmentD1Limit: 1000,
    targets: [
      {
        unitKey: 'tenant-1:default',
        priority: 30,
        readyUnits: 0,
        inFlightUnits: 0,
        minimumRequiredUnits: 1,
        recommendedTargetUnits: 1,
        hardMaximumUnits: 3,
        resources: [
          {
            resourceClass: 'd1',
            dataRole: 'tenant_core/default',
            residencyPolicyId: 'builtin:residency:default',
            residencyPartition: 'default',
            workerScripts: ['test-ar-management'],
            d1Count: 1,
          },
        ],
      },
      {
        unitKey: 'tenant-1:users',
        priority: 20,
        readyUnits: 0,
        inFlightUnits: 0,
        minimumRequiredUnits: 1,
        recommendedTargetUnits: 1,
        hardMaximumUnits: 3,
        resources: [
          {
            resourceClass: 'd1',
            dataRole: 'tenant_core/users',
            residencyPolicyId: 'builtin:residency:default',
            residencyPartition: 'default',
            workerScripts: ['test-ar-auth'],
            d1Count: 1,
          },
        ],
      },
      {
        unitKey: 'tenant-1:pii',
        priority: 10,
        readyUnits: 0,
        inFlightUnits: 0,
        minimumRequiredUnits: 1,
        recommendedTargetUnits: 1,
        hardMaximumUnits: 3,
        resources: [
          {
            resourceClass: 'd1',
            dataRole: 'tenant_pii',
            residencyPolicyId: 'builtin:residency:default',
            residencyPartition: 'default',
            workerScripts: ['test-ar-userinfo'],
            d1Count: 1,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('planControlCapacity', () => {
  it('builds the minimum complete tenant-exclusive capacity from server-owned targets', () => {
    const plan = planControlCapacity(input({ profile: 'minimum' }));

    expect(plan.available).toBe(true);
    expect(plan.capacityUnitsAdded).toBe(3);
    expect(plan.d1DatabasesAdded).toBe(3);
    expect(plan.targets.map((target) => target.resources[0]?.dataRole)).toEqual([
      'tenant_core/default',
      'tenant_core/users',
      'tenant_pii',
    ]);
  });

  it('counts in-flight units so concurrent executors do not over-provision', () => {
    const target = input().targets[0]!;
    const plan = planControlCapacity(
      input({
        profile: 'recommended',
        targets: [{ ...target, inFlightUnits: 1 }],
      })
    );

    expect(plan.capacityUnitsAdded).toBe(0);
    expect(plan.projectedEnvironmentD1Count).toBe(10);
  });

  it('adds exactly one deterministic spare unit for extra headroom', () => {
    const plan = planControlCapacity(input({ profile: 'extra_headroom' }));

    expect(plan.capacityUnitsAdded).toBe(4);
    expect(plan.targets.map((target) => target.addUnits)).toEqual([2, 1, 1]);
  });

  it('adds repeated headroom to the target with the least existing spare capacity', () => {
    const targets = input().targets.map((target, index) => ({
      ...target,
      readyUnits: index === 0 ? 2 : 1,
    }));
    const plan = planControlCapacity(input({ profile: 'extra_headroom', targets }));

    expect(plan.capacityUnitsAdded).toBe(1);
    expect(plan.targets.map((target) => target.addUnits)).toEqual([0, 1, 0]);
    expect(plan.targets.map((target) => target.projectedUnits)).toEqual([2, 2, 1]);
  });

  it('fails closed when the selected profile exceeds the environment D1 cap', () => {
    const plan = planControlCapacity(
      input({ profile: 'minimum', currentEnvironmentD1Count: 998, environmentD1Limit: 1000 })
    );

    expect(plan.available).toBe(false);
    expect(plan.reasonCode).toBe('environment_d1_limit');
  });

  it('rejects cross-scope tenant ownership before planning', () => {
    expect(() =>
      planControlCapacity(input({ scope: 'shared_pool', tenantId: 'tenant-1' }))
    ).toThrow('control_capacity_scope_owner_invalid');
  });

  it('keeps tenant-exclusive capacity elastic within its server-owned hard maximum', () => {
    const plan = planControlCapacity(input({ profile: 'extra_headroom' }));

    expect(plan.available).toBe(true);
    expect(plan.reasonCode).toBeNull();
    expect(plan.targets.map((target) => target.projectedUnits)).toEqual([2, 1, 1]);
  });

  it('marks extra headroom unavailable when every server-owned target is at its cap', () => {
    const targets = input().targets.map((target) => ({
      ...target,
      readyUnits: 1,
      hardMaximumUnits: 1,
    }));
    const plan = planControlCapacity(input({ profile: 'extra_headroom', targets }));

    expect(plan.available).toBe(false);
    expect(plan.reasonCode).toBe('capacity_profile_unavailable');
    expect(plan.capacityUnitsAdded).toBe(0);
  });

  it('rejects unknown runtime profile and scope values', () => {
    expect(() =>
      planControlCapacity(input({ profile: 'raw_count' as ControlCapacityPlannerInput['profile'] }))
    ).toThrow('control_capacity_profile_invalid');
    expect(() =>
      planControlCapacity(input({ scope: 'global' as ControlCapacityPlannerInput['scope'] }))
    ).toThrow('control_capacity_scope_invalid');
  });
});
