export type ControlCapacityProfile = 'minimum' | 'recommended' | 'extra_headroom';
export type ControlCapacityScope = 'tenant_exclusive' | 'shared_pool';
export type ControlCapacityDataRole =
  | 'tenant_core/default'
  | 'tenant_core/users'
  | 'tenant_pii'
  | 'lookup';

export interface ControlCapacityUnitResource {
  resourceClass: 'd1';
  dataRole: ControlCapacityDataRole;
  residencyPolicyId: string;
  residencyPartition: string;
  lookupCapacityDomainId?: string;
  workerScripts: readonly string[];
  d1Count: number;
}

export interface ControlCapacityTargetInput {
  unitKey: string;
  priority: number;
  readyUnits: number;
  inFlightUnits: number;
  minimumRequiredUnits: number;
  recommendedTargetUnits: number;
  hardMaximumUnits: number;
  resources: readonly ControlCapacityUnitResource[];
}

export interface ControlCapacityPlannerInput {
  profile: ControlCapacityProfile;
  scope: ControlCapacityScope;
  tenantId: string | null;
  currentEnvironmentD1Count: number;
  environmentD1Limit: number;
  targets: readonly ControlCapacityTargetInput[];
}

export interface ControlCapacityTargetPlan extends ControlCapacityTargetInput {
  addUnits: number;
  projectedUnits: number;
  addedD1Count: number;
}

export interface ControlCapacityPlan {
  profile: ControlCapacityProfile;
  scope: ControlCapacityScope;
  tenantId: string | null;
  targets: readonly ControlCapacityTargetPlan[];
  capacityUnitsAdded: number;
  d1DatabasesAdded: number;
  projectedEnvironmentD1Count: number;
  available: boolean;
  reasonCode: 'capacity_profile_unavailable' | 'environment_d1_limit' | null;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

function safeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`control_capacity_${field}_invalid`);
  }
  return value;
}

function validateResource(resource: ControlCapacityUnitResource): void {
  if (
    !SAFE_ID.test(resource.residencyPolicyId) ||
    !SAFE_ID.test(resource.residencyPartition) ||
    (resource.lookupCapacityDomainId !== undefined &&
      !SAFE_ID.test(resource.lookupCapacityDomainId)) ||
    !['tenant_core/default', 'tenant_core/users', 'tenant_pii', 'lookup'].includes(
      resource.dataRole
    )
  ) {
    throw new Error('control_capacity_resource_invalid');
  }
  safeInteger(resource.d1Count, 'resource_d1_count');
  if (resource.d1Count < 1 || resource.workerScripts.length < 1) {
    throw new Error('control_capacity_resource_invalid');
  }
  if (
    new Set(resource.workerScripts).size !== resource.workerScripts.length ||
    resource.workerScripts.some((script) => !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(script))
  ) {
    throw new Error('control_capacity_worker_script_invalid');
  }
}

function validateTarget(target: ControlCapacityTargetInput): void {
  if (!SAFE_ID.test(target.unitKey)) throw new Error('control_capacity_unit_key_invalid');
  safeInteger(target.priority, 'priority');
  safeInteger(target.readyUnits, 'ready_units');
  safeInteger(target.inFlightUnits, 'in_flight_units');
  safeInteger(target.minimumRequiredUnits, 'minimum_required_units');
  safeInteger(target.recommendedTargetUnits, 'recommended_target_units');
  safeInteger(target.hardMaximumUnits, 'hard_maximum_units');
  if (
    target.minimumRequiredUnits > target.recommendedTargetUnits ||
    target.recommendedTargetUnits > target.hardMaximumUnits ||
    target.resources.length < 1
  ) {
    throw new Error('control_capacity_target_bounds_invalid');
  }
  target.resources.forEach(validateResource);
}

function plannedTargetUnits(
  target: ControlCapacityTargetInput,
  profile: Exclude<ControlCapacityProfile, 'extra_headroom'>
): number {
  return profile === 'minimum' ? target.minimumRequiredUnits : target.recommendedTargetUnits;
}

/**
 * Produce the same server-owned capacity decision for setup, Admin, and Control executors.
 * Names and provider IDs are deliberately absent; those come from deterministic desired state.
 */
export function planControlCapacity(input: ControlCapacityPlannerInput): ControlCapacityPlan {
  if (!['minimum', 'recommended', 'extra_headroom'].includes(input.profile)) {
    throw new Error('control_capacity_profile_invalid');
  }
  if (!['tenant_exclusive', 'shared_pool'].includes(input.scope)) {
    throw new Error('control_capacity_scope_invalid');
  }
  if (
    (input.scope === 'tenant_exclusive' && !input.tenantId) ||
    (input.scope === 'shared_pool' && input.tenantId !== null)
  ) {
    throw new Error('control_capacity_scope_owner_invalid');
  }
  safeInteger(input.currentEnvironmentD1Count, 'current_d1_count');
  safeInteger(input.environmentD1Limit, 'environment_d1_limit');
  if (input.currentEnvironmentD1Count > input.environmentD1Limit) {
    throw new Error('control_capacity_environment_limit_invalid');
  }
  const keys = new Set<string>();
  input.targets.forEach((target) => {
    validateTarget(target);
    if (keys.has(target.unitKey)) throw new Error('control_capacity_unit_key_duplicate');
    keys.add(target.unitKey);
  });

  const baseProfile = input.profile === 'minimum' ? 'minimum' : 'recommended';
  const additions = new Map<string, number>();
  for (const target of input.targets) {
    const existing = target.readyUnits + target.inFlightUnits;
    additions.set(target.unitKey, Math.max(0, plannedTargetUnits(target, baseProfile) - existing));
  }

  let profileUnavailable = false;
  if (input.profile === 'extra_headroom') {
    const extraTarget = [...input.targets]
      .filter((target) => {
        const existing = target.readyUnits + target.inFlightUnits;
        return existing + (additions.get(target.unitKey) ?? 0) < target.hardMaximumUnits;
      })
      .sort((left, right) => {
        const leftProjected =
          left.readyUnits + left.inFlightUnits + (additions.get(left.unitKey) ?? 0);
        const rightProjected =
          right.readyUnits + right.inFlightUnits + (additions.get(right.unitKey) ?? 0);
        const headroomDifference =
          leftProjected -
          left.recommendedTargetUnits -
          (rightProjected - right.recommendedTargetUnits);
        return (
          headroomDifference ||
          right.priority - left.priority ||
          left.unitKey.localeCompare(right.unitKey)
        );
      })[0];
    if (extraTarget) {
      additions.set(extraTarget.unitKey, (additions.get(extraTarget.unitKey) ?? 0) + 1);
    } else {
      profileUnavailable = true;
    }
  }

  const targets = input.targets.map<ControlCapacityTargetPlan>((target) => {
    const addUnits = additions.get(target.unitKey) ?? 0;
    const projectedUnits = target.readyUnits + target.inFlightUnits + addUnits;
    if (!Number.isSafeInteger(projectedUnits)) {
      throw new Error('control_capacity_projected_units_invalid');
    }
    if (projectedUnits > target.hardMaximumUnits) profileUnavailable = true;
    const d1PerUnit = target.resources.reduce((total, resource) => total + resource.d1Count, 0);
    if (!Number.isSafeInteger(d1PerUnit) || !Number.isSafeInteger(addUnits * d1PerUnit)) {
      throw new Error('control_capacity_projected_d1_count_invalid');
    }
    return {
      ...target,
      addUnits,
      projectedUnits,
      addedD1Count: addUnits * d1PerUnit,
    };
  });
  const capacityUnitsAdded = targets.reduce((total, target) => total + target.addUnits, 0);
  const d1DatabasesAdded = targets.reduce((total, target) => total + target.addedD1Count, 0);
  const projectedEnvironmentD1Count = input.currentEnvironmentD1Count + d1DatabasesAdded;
  if (
    !Number.isSafeInteger(capacityUnitsAdded) ||
    !Number.isSafeInteger(d1DatabasesAdded) ||
    !Number.isSafeInteger(projectedEnvironmentD1Count)
  ) {
    throw new Error('control_capacity_projected_d1_count_invalid');
  }
  const environmentLimitExceeded = projectedEnvironmentD1Count > input.environmentD1Limit;

  return {
    profile: input.profile,
    scope: input.scope,
    tenantId: input.tenantId,
    targets,
    capacityUnitsAdded,
    d1DatabasesAdded,
    projectedEnvironmentD1Count,
    available: !profileUnavailable && !environmentLimitExceeded,
    reasonCode: profileUnavailable
      ? 'capacity_profile_unavailable'
      : environmentLimitExceeded
        ? 'environment_d1_limit'
        : null,
  };
}
