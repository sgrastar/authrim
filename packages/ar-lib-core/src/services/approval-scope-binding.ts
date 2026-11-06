import type { DatabaseAdapter } from '../db/adapter';
import type {
  ApprovalRequest,
  ApprovalRequestApproval,
  ApprovalTargetSubjectType,
  ElevationGrant,
} from '../types/approval';
import {
  ApprovalRequestApprovalRepository,
  ApprovalRequestRepository,
} from '../repositories/admin/admin-approval-request';

/**
 * What an approval may open, given who approves it.
 *
 * A request names a target (whose approval is asked) and a scope (what the grant opens) apart. A
 * user's approval only speaks for that user's own data, so:
 * - `customer_profile` opens exactly the target user's profile, whoever approves it;
 * - every other class (admin resources, `verified_attribute`, classes not listed anywhere) needs an
 *   admin's approval, since no end user owns it;
 * - a scope that names no resource is refused, because an empty `resource_ids` matches anything.
 */

/** Resource classes only the server files requests for (Support Ops, agent MCP elevation). */
export const INTERNAL_APPROVAL_RESOURCE_CLASSES: ReadonlySet<string> = new Set([
  'support_operation_cohort',
  'agent_elevation',
]);

const TARGET_BOUND_RESOURCE_CLASSES: ReadonlySet<string> = new Set(['customer_profile']);

export function normalizeApprovalResourceIds(
  values: readonly unknown[] | null | undefined
): string[] {
  if (!values) {
    return [];
  }
  return Array.from(
    new Set(
      values
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter((value) => value.length > 0)
    )
  );
}

export interface ApprovalScopeBindingInput {
  targetSubjectType: ApprovalTargetSubjectType;
  targetSubjectId: string;
  resourceClass: string;
  resourceIds: readonly unknown[] | null | undefined;
  steps: ReadonlyArray<Pick<ApprovalRequestApproval, 'side' | 'subject_type'>>;
}

/** Why the scope is not one these approvers can grant, or null when it is. */
export function findApprovalScopeBindingViolation(input: ApprovalScopeBindingInput): string | null {
  const resourceIds = normalizeApprovalResourceIds(input.resourceIds);
  if (resourceIds.length === 0) {
    return 'resource_ids must name at least one resource';
  }

  const resourceClass = input.resourceClass.trim();
  if (TARGET_BOUND_RESOURCE_CLASSES.has(resourceClass)) {
    if (
      input.targetSubjectType !== 'user' ||
      resourceIds.length !== 1 ||
      resourceIds[0] !== input.targetSubjectId
    ) {
      return `${resourceClass} must be requested for the target user alone`;
    }
    return null;
  }

  const hasAdminStep = input.steps.some(
    (step) => step.side === 'admin_operator' && step.subject_type === 'admin_user'
  );
  if (!hasAdminStep) {
    return `${resourceClass} must be approved by an admin operator`;
  }
  return null;
}

export function findApprovalRequestBindingViolation(
  request: Pick<ApprovalRequest, 'target_subject_type' | 'target_subject_id' | 'scope_json'>,
  steps: ReadonlyArray<Pick<ApprovalRequestApproval, 'side' | 'subject_type'>>
): string | null {
  return findApprovalScopeBindingViolation({
    targetSubjectType: request.target_subject_type,
    targetSubjectId: request.target_subject_id,
    resourceClass: request.scope_json.resource_class,
    resourceIds: request.scope_json.resource_ids,
    steps,
  });
}

/**
 * Whether a grant issued earlier still matches the rule above. Grants are checked where they are
 * used, so ones issued before the rule existed cannot open more than it allows.
 */
export async function isElevationGrantBindingIntact(
  adapter: DatabaseAdapter,
  grant: Pick<ElevationGrant, 'approval_request_id' | 'resource_class' | 'scope_json'>
): Promise<boolean> {
  const request = await new ApprovalRequestRepository(adapter).getApprovalRequestById(
    grant.approval_request_id
  );
  if (!request) {
    return false;
  }
  const steps = await new ApprovalRequestApprovalRepository(adapter).listApprovalsForRequest(
    request.id
  );
  return (
    findApprovalScopeBindingViolation({
      targetSubjectType: request.target_subject_type,
      targetSubjectId: request.target_subject_id,
      resourceClass: grant.resource_class,
      resourceIds: grant.scope_json?.resource_ids,
      steps,
    }) === null && findApprovalRequestBindingViolation(request, steps) === null
  );
}
