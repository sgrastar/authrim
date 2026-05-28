export type ProvisioningAssignmentEventType = 'import' | 'jit' | 'registration';
export type ProvisioningAssignmentTargetType = 'group' | 'entitlement' | 'permission';
export type LifecycleSignalType =
  | 'scim_active_false'
  | 'scim_group_removed'
  | 'csv_diff_removed'
  | 'claim_disappeared';
export type ProvisioningRevocationDecision = 'revoke' | 'review' | 'keep' | 'suspend_account';

export interface ProvisioningAssignmentCondition {
  eventTypes?: ProvisioningAssignmentEventType[];
  sourceTypes?: string[];
  sourceIds?: string[];
  domain?: string;
  domains?: string[];
  claims?: Record<string, string | number | boolean>;
}

export interface ProvisioningAssignmentRuleLike {
  id: string;
  targetType: ProvisioningAssignmentTargetType;
  targetId: string;
  condition: ProvisioningAssignmentCondition;
  priority?: number;
}

export interface ProvisioningAssignmentContext {
  eventType: ProvisioningAssignmentEventType;
  sourceType?: string;
  sourceId?: string;
  domain?: string | null;
  claims?: Record<string, unknown>;
}

export interface ProvisioningAssignmentEvaluation {
  matched: boolean;
  ruleId: string;
  targetType: ProvisioningAssignmentTargetType;
  targetId: string;
  reasonCodes: string[];
}

export interface ProvisioningAssignmentOwnershipContext {
  assignmentType: string;
  assignmentId: string;
  ownershipPolicy?: 'source_owned' | 'manual' | 'protected' | string | null;
  revokePolicy?: 'auto' | 'review' | 'keep' | string | null;
  protectedUntil?: number | null;
}

export interface LifecycleSignalDecisionInput {
  signalType: LifecycleSignalType;
  targetType: 'account' | 'group_membership' | 'entitlement' | 'permission';
  targetId: string;
  ownership?: ProvisioningAssignmentOwnershipContext | null;
  now?: number;
}

export interface LifecycleSignalDecisionResult {
  decision: ProvisioningRevocationDecision;
  reasonCodes: string[];
}

export const PROVISIONING_ASSIGNMENT_REASON_CODES = {
  matched: 'provisioning.assignment.matched',
  eventTypeMismatch: 'provisioning.assignment.event_type_mismatch',
  sourceTypeMismatch: 'provisioning.assignment.source_type_mismatch',
  sourceIdMismatch: 'provisioning.assignment.source_id_mismatch',
  domainMismatch: 'provisioning.assignment.domain_mismatch',
  claimMismatch: 'provisioning.assignment.claim_mismatch',
} as const;

export const LIFECYCLE_SIGNAL_REASON_CODES = {
  scimActiveFalse: 'lifecycle_signal.scim_active_false',
  scimGroupRemoved: 'lifecycle_signal.scim_group_removed',
  csvDiffRemoved: 'lifecycle_signal.csv_diff_removed',
  claimDisappeared: 'lifecycle_signal.claim_disappeared',
  protectedAssignment: 'provisioning.revocation.protected_assignment',
  manualAssignment: 'provisioning.revocation.manual_assignment',
  reviewRequired: 'provisioning.revocation.review_required',
  sourceOwnedAuto: 'provisioning.revocation.source_owned_auto',
  keepPolicy: 'provisioning.revocation.keep_policy',
} as const;

export function evaluateProvisioningAssignmentRule(
  rule: ProvisioningAssignmentRuleLike,
  context: ProvisioningAssignmentContext
): ProvisioningAssignmentEvaluation {
  const reasons: string[] = [];
  const condition = rule.condition;

  if (condition.eventTypes?.length && !condition.eventTypes.includes(context.eventType)) {
    reasons.push(PROVISIONING_ASSIGNMENT_REASON_CODES.eventTypeMismatch);
  }
  if (
    condition.sourceTypes?.length &&
    (!context.sourceType || !condition.sourceTypes.includes(context.sourceType))
  ) {
    reasons.push(PROVISIONING_ASSIGNMENT_REASON_CODES.sourceTypeMismatch);
  }
  if (
    condition.sourceIds?.length &&
    (!context.sourceId || !condition.sourceIds.includes(context.sourceId))
  ) {
    reasons.push(PROVISIONING_ASSIGNMENT_REASON_CODES.sourceIdMismatch);
  }

  const expectedDomains = [
    ...(condition.domain ? [condition.domain] : []),
    ...(condition.domains ?? []),
  ].map(normalizeDomain);
  if (expectedDomains.length && !expectedDomains.includes(normalizeDomain(context.domain))) {
    reasons.push(PROVISIONING_ASSIGNMENT_REASON_CODES.domainMismatch);
  }

  for (const [claim, expected] of Object.entries(condition.claims ?? {})) {
    if (context.claims?.[claim] !== expected) {
      reasons.push(PROVISIONING_ASSIGNMENT_REASON_CODES.claimMismatch);
    }
  }

  return {
    matched: reasons.length === 0,
    ruleId: rule.id,
    targetType: rule.targetType,
    targetId: rule.targetId,
    reasonCodes: reasons.length === 0 ? [PROVISIONING_ASSIGNMENT_REASON_CODES.matched] : reasons,
  };
}

export function decideLifecycleSignalRevocation(
  input: LifecycleSignalDecisionInput
): LifecycleSignalDecisionResult {
  const reasonCodes = [signalReasonCode(input.signalType)];

  if (input.signalType === 'scim_active_false' && input.targetType === 'account') {
    return {
      decision: 'suspend_account',
      reasonCodes,
    };
  }

  const ownershipPolicy = input.ownership?.ownershipPolicy ?? 'source_owned';
  const revokePolicy = input.ownership?.revokePolicy ?? 'review';
  const now = input.now ?? Date.now();

  if (revokePolicy === 'keep') {
    return {
      decision: 'keep',
      reasonCodes: [...reasonCodes, LIFECYCLE_SIGNAL_REASON_CODES.keepPolicy],
    };
  }
  if (input.ownership?.protectedUntil && input.ownership.protectedUntil > now) {
    return {
      decision: 'review',
      reasonCodes: [...reasonCodes, LIFECYCLE_SIGNAL_REASON_CODES.protectedAssignment],
    };
  }
  if (ownershipPolicy === 'manual' || ownershipPolicy === 'protected') {
    return {
      decision: 'review',
      reasonCodes: [...reasonCodes, LIFECYCLE_SIGNAL_REASON_CODES.manualAssignment],
    };
  }
  if (revokePolicy === 'auto') {
    return {
      decision: 'revoke',
      reasonCodes: [...reasonCodes, LIFECYCLE_SIGNAL_REASON_CODES.sourceOwnedAuto],
    };
  }
  return {
    decision: 'review',
    reasonCodes: [...reasonCodes, LIFECYCLE_SIGNAL_REASON_CODES.reviewRequired],
  };
}

function signalReasonCode(signalType: LifecycleSignalType): string {
  switch (signalType) {
    case 'scim_active_false':
      return LIFECYCLE_SIGNAL_REASON_CODES.scimActiveFalse;
    case 'scim_group_removed':
      return LIFECYCLE_SIGNAL_REASON_CODES.scimGroupRemoved;
    case 'csv_diff_removed':
      return LIFECYCLE_SIGNAL_REASON_CODES.csvDiffRemoved;
    case 'claim_disappeared':
      return LIFECYCLE_SIGNAL_REASON_CODES.claimDisappeared;
  }
}

function normalizeDomain(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}
