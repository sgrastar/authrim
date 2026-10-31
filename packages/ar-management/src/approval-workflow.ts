import { samlDrAll } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer';
import type { Context } from 'hono';
import type {
  ApprovalApproverSubjectType,
  ApprovalDecisionStatus,
  ApprovalRequest,
  ApprovalRequestApproval,
  ApprovalRequestRepository,
  ApprovalRequestStatus,
  ApprovalTransportMethod,
  DatabaseAdapter,
  ElevationGrant,
  ElevationGrantRepository,
  Env,
} from '@authrim/ar-lib-core';
import { ApprovalRequestApprovalRepository, getTenantSettingsDocument } from '@authrim/ar-lib-core';
import { appendApprovalTransportEvent } from './approval-transport-detail';

type AppContext = Context<any, any, any>;

export class ApprovalWorkflowPolicyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 409
  ) {
    super(message);
    this.name = 'ApprovalWorkflowPolicyError';
  }
}

function isBooleanTrue(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

async function isSupportOpsSelfApprovalAllowed(c: AppContext, tenantId: string): Promise<boolean> {
  const env = c.env as Env | undefined;
  const settings = await getTenantSettingsDocument(env ?? {}, tenantId, 'support-ops');

  return isBooleanTrue(settings?.['support_ops.allow_self_approval']);
}

/**
 * Whether two subjects are the same one. A machine credential is recorded as an `admin_user` or
 * a `service_principal` depending on the route, with the same principal id, so the two admin-side
 * types are compared by id alone.
 */
function isSameApprovalSubject(
  leftType: ApprovalApproverSubjectType | null,
  leftId: string | null,
  rightType: ApprovalApproverSubjectType | null,
  rightId: string | null
): boolean {
  if (leftId === null || rightId === null || leftId !== rightId) {
    return false;
  }
  const adminSide = (type: ApprovalApproverSubjectType | null) =>
    type === 'admin_user' || type === 'service_principal';
  return leftType === rightType || (adminSide(leftType) && adminSide(rightType));
}

async function assertApprovalDecisionPolicy(
  c: AppContext,
  input: {
    request: ApprovalRequest;
    approval: ApprovalRequestApproval;
    nextStatus: ApprovalDecisionStatus;
    actorSubjectType: ApprovalApproverSubjectType | null;
    actorSubjectId: string | null;
  }
): Promise<void> {
  if (input.nextStatus !== 'approved' && input.nextStatus !== 'denied') {
    return;
  }

  // A decision is made once, while the request is open. Without this a denied step could be
  // approved afterwards (the request status is worked out again from its steps), and a request
  // past its deadline could still be approved.
  if (input.request.status !== 'pending' && input.request.status !== 'partially_approved') {
    throw new ApprovalWorkflowPolicyError(
      'approval_request_not_pending',
      'Only pending or partially approved requests can be decided.'
    );
  }
  if (input.approval.status !== 'pending') {
    throw new ApprovalWorkflowPolicyError(
      'approval_step_not_pending',
      'Only pending approval steps can be decided.'
    );
  }
  const now = Date.now();
  if (input.request.expires_at <= now || input.approval.expires_at <= now) {
    throw new ApprovalWorkflowPolicyError(
      'approval_request_expired',
      'The approval request has expired.'
    );
  }

  // An approval says who approved. Without an identified approver the next check cannot tell
  // the requester from anyone else (a portal completion for a step nobody was named on).
  if (input.nextStatus === 'approved' && input.actorSubjectId === null) {
    throw new ApprovalWorkflowPolicyError(
      'approver_identity_required',
      'The approver must be identified.'
    );
  }

  // The requester never approves their own request. Only Support Ops lets a tenant allow it
  // (`support_ops.allow_self_approval`, off by default); every other surface, including ones
  // not named here, is two-person.
  if (
    input.nextStatus === 'approved' &&
    isSameApprovalSubject(
      input.request.requester_subject_type,
      input.request.requester_subject_id,
      input.actorSubjectType,
      input.actorSubjectId
    ) &&
    !(
      input.request.request_surface === 'support_ops' &&
      (await isSupportOpsSelfApprovalAllowed(c, input.request.tenant_id))
    )
  ) {
    throw new ApprovalWorkflowPolicyError(
      'self_approval_not_allowed',
      'This request must be approved by a different admin operator.'
    );
  }
}

function buildGrantAuthorizationDetails(request: ApprovalRequest): Record<string, unknown> {
  return {
    type: 'authrim_break_glass',
    investigation_id: request.investigation_id,
    request_surface: request.request_surface,
    requested_action: request.requested_action,
    resource_class: request.scope_json.resource_class,
    resource_ids: request.scope_json.resource_ids ?? [],
    detail_classes: request.scope_json.detail_classes ?? [],
    redaction_level: request.redaction_level,
    ticket_reference: request.ticket_reference,
    reference: request.reference,
    policy_preset: request.policy_preset,
    reuse_scope: request.reuse_scope,
  };
}

export function syncApprovalRequestStatus(
  approvals: ApprovalRequestApproval[]
): ApprovalRequestStatus {
  if (approvals.some((approval) => approval.status === 'denied')) {
    return 'denied';
  }
  if (approvals.some((approval) => approval.status === 'cancelled')) {
    return 'cancelled';
  }
  if (approvals.some((approval) => approval.status === 'expired')) {
    return 'expired';
  }
  if (approvals.length > 0 && approvals.every((approval) => approval.status === 'approved')) {
    return 'approved';
  }
  if (approvals.some((approval) => approval.status === 'approved')) {
    return 'partially_approved';
  }
  return 'pending';
}

export async function syncElevationGrantsForRequest(
  grantRepo: ElevationGrantRepository,
  request: ApprovalRequest
): Promise<ElevationGrant[]> {
  const existingGrants = await grantRepo.listElevationGrantsForRequest(request.id);
  const activeGrants = existingGrants.filter(
    (grant: ElevationGrant) =>
      grant.status === 'active' && !grant.revoked_at && grant.expires_at > Date.now()
  );

  if (request.status === 'approved') {
    if (activeGrants.length === 0) {
      // The insert itself refuses a second active grant, so two approvers who complete the
      // request together still end up with one.
      await grantRepo.createElevationGrant(
        {
          approval_request_id: request.id,
          tenant_id: request.tenant_id,
          target_audience: 'admin_api',
          resource_class: request.scope_json.resource_class,
          redaction_level: request.redaction_level,
          scope_json: request.scope_json,
          scope_canonical: request.scope_canonical,
          authorization_details_json: buildGrantAuthorizationDetails(request),
          requester_subject_type: request.requester_subject_type,
          requester_subject_id: request.requester_subject_id,
          actor_subject_type: request.requester_subject_type,
          actor_subject_id: request.requester_subject_id,
          expires_at: request.expires_at,
        },
        { onlyIfNoActiveGrant: true }
      );
    }
    return grantRepo.listElevationGrantsForRequest(request.id);
  }

  if (['cancelled', 'denied', 'expired'].includes(request.status)) {
    await samlDrAll(
      activeGrants.map((grant) =>
        grantRepo.updateElevationGrantStatus(grant.id, 'revoked', {
          revokedAt: Date.now(),
          revokeReason: `approval_request_${request.status}`,
        })
      )
    );
  }

  return grantRepo.listElevationGrantsForRequest(request.id);
}

export async function applyApprovalDecisionForRequest(
  c: AppContext,
  deps: {
    adapter: DatabaseAdapter;
    requestRepo: ApprovalRequestRepository;
    approvalRepo: ApprovalRequestApprovalRepository;
    grantRepo: ElevationGrantRepository;
  },
  input: {
    request: ApprovalRequest;
    approval: ApprovalRequestApproval;
    nextStatus: ApprovalDecisionStatus;
    actorSubjectType: ApprovalApproverSubjectType | null;
    actorSubjectId: string | null;
    method?: ApprovalTransportMethod | null;
    transportChannel?: string | null;
    reasonCode?: string | null;
    reasonNote?: string | null;
    transportSummary?: {
      provider?: string | null;
      delivery_status?: string | null;
      target?: string | null;
      correlation_id?: string | null;
      transport_request_id?: string | null;
    } | null;
    transportDetail?: {
      request?: Record<string, unknown> | null;
      response?: Record<string, unknown> | null;
      metadata?: Record<string, unknown> | null;
    } | null;
    occurredAt?: number;
  }
): Promise<{
  request: ApprovalRequest;
  approvals: ApprovalRequestApproval[];
  grants: ElevationGrant[];
}> {
  await assertApprovalDecisionPolicy(c, {
    request: input.request,
    approval: input.approval,
    nextStatus: input.nextStatus,
    actorSubjectType: input.actorSubjectType,
    actorSubjectId: input.actorSubjectId,
  });

  const updatedApproval = await deps.approvalRepo.updateApproval(
    input.approval.id,
    {
      status: input.nextStatus,
      subject_id:
        input.nextStatus === 'approved' &&
        input.approval.subject_type === 'admin_user' &&
        !input.approval.subject_id &&
        input.actorSubjectType === 'admin_user' &&
        input.actorSubjectId
          ? input.actorSubjectId
          : undefined,
      method: input.method ?? null,
      transport_channel: input.transportChannel ?? null,
      reason_code: input.reasonCode ?? null,
      reason_note: input.reasonNote ?? null,
      decided_at: input.occurredAt ?? Date.now(),
    },
    // The step must still be pending when the write lands: of two decisions made together, one wins.
    { expectedStatus: 'pending', openAt: Date.now() }
  );
  if (!updatedApproval) {
    throw new ApprovalWorkflowPolicyError(
      'approval_step_not_pending',
      'Only pending approval steps can be decided.'
    );
  }

  const approvals = await deps.approvalRepo.listApprovalsForRequest(input.request.id);
  const updatedRequest = await deps.requestRepo.recomputeApprovalRequestStatus(input.request.id);
  const effectiveRequest = updatedRequest ?? input.request;
  const requestWithDetail = await appendApprovalTransportEvent(
    c,
    deps.adapter,
    deps.requestRepo,
    effectiveRequest,
    {
      kind: input.nextStatus === 'approved' ? 'step_approved' : 'step_denied',
      actorSubjectType: input.actorSubjectType,
      actorSubjectId: input.actorSubjectId,
      requestStatus: effectiveRequest.status,
      approval:
        approvals.find((item) => item.id === input.approval.id) ??
        updatedApproval ??
        input.approval,
      method: input.method ?? null,
      transportChannel: input.transportChannel ?? null,
      reasonCode: input.reasonCode ?? null,
      reasonNote: input.reasonNote ?? null,
      transportSummary: input.transportSummary ?? null,
      transportDetail: input.transportDetail ?? null,
      occurredAt: input.occurredAt,
    }
  );
  const grants = await syncElevationGrantsForRequest(deps.grantRepo, requestWithDetail);

  return {
    request: requestWithDetail,
    approvals,
    grants,
  };
}
