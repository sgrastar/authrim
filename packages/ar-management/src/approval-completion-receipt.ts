import type {
  ApprovalCompletionArtifact,
  ApprovalDecisionReceipt,
  ApprovalRequest,
  ApprovalRequestApproval,
  ApprovalRequestStatus,
  Env,
  ElevationGrant,
} from '@authrim/ar-lib-core';
import {
  generatePublicApprovalDecisionReceiptId,
  getChallengeStoreByChallengeId,
  type Challenge,
} from '@authrim/ar-lib-core';

const APPROVAL_DECISION_RECEIPT_CHALLENGE_TYPE = 'approval_decision_receipt';
const DEFAULT_RECEIPT_TTL_SECONDS = 24 * 60 * 60;

function toApprovalDecisionReceipt(challenge: Challenge): ApprovalDecisionReceipt | null {
  if (challenge.type !== APPROVAL_DECISION_RECEIPT_CHALLENGE_TYPE) {
    return null;
  }

  const metadata = challenge.metadata as Record<string, unknown> | undefined;
  if (!metadata) {
    return null;
  }

  return {
    receipt_id: challenge.id,
    artifact_id: String(metadata.artifact_id ?? ''),
    tenant_id: String(metadata.tenant_id ?? ''),
    request_id: String(metadata.request_id ?? ''),
    approval_id: String(metadata.approval_id ?? ''),
    step_key: String(metadata.step_key ?? ''),
    investigation_id: String(metadata.investigation_id ?? ''),
    request_surface: String(metadata.request_surface ?? ''),
    requested_action: String(metadata.requested_action ?? ''),
    target_subject_type: metadata.target_subject_type as ApprovalRequest['target_subject_type'],
    target_subject_id: String(metadata.target_subject_id ?? ''),
    requester_subject_type:
      metadata.requester_subject_type as ApprovalRequest['requester_subject_type'],
    requester_subject_id: String(metadata.requester_subject_id ?? ''),
    approver_side: metadata.approver_side as ApprovalRequestApproval['side'],
    approver_subject_type:
      metadata.approver_subject_type as ApprovalRequestApproval['subject_type'],
    approver_subject_id:
      typeof metadata.approver_subject_id === 'string' ? metadata.approver_subject_id : null,
    relation_type: typeof metadata.relation_type === 'string' ? metadata.relation_type : null,
    relation_source: typeof metadata.relation_source === 'string' ? metadata.relation_source : null,
    method: metadata.method as ApprovalCompletionArtifact['method'],
    transport_channel:
      typeof metadata.transport_channel === 'string' ? metadata.transport_channel : null,
    redaction_level: metadata.redaction_level as ApprovalRequest['redaction_level'],
    request_status: metadata.request_status as ApprovalRequestStatus,
    decision: metadata.decision as ApprovalRequestApproval['status'],
    grant_ids: Array.isArray(metadata.grant_ids)
      ? metadata.grant_ids.filter((value): value is string => typeof value === 'string')
      : [],
    reference:
      typeof metadata.reference === 'object' && metadata.reference !== null
        ? (metadata.reference as ApprovalRequest['reference'])
        : null,
    ticket_reference:
      typeof metadata.ticket_reference === 'object' && metadata.ticket_reference !== null
        ? (metadata.ticket_reference as ApprovalRequest['ticket_reference'])
        : null,
    completed_at: Number(metadata.completed_at ?? challenge.createdAt),
    expires_at: challenge.expiresAt,
    created_at: challenge.createdAt,
  };
}

function buildReceiptMetadata(input: {
  artifact: ApprovalCompletionArtifact;
  request: ApprovalRequest;
  approval: ApprovalRequestApproval;
  decision: ApprovalRequestApproval['status'];
  requestStatus: ApprovalRequestStatus;
  grants: ElevationGrant[];
  completedAt: number;
}): Record<string, unknown> {
  return {
    artifact_id: input.artifact.artifact_id,
    tenant_id: input.request.tenant_id,
    request_id: input.request.public_request_id,
    approval_id: input.approval.id,
    step_key: input.approval.step_key,
    investigation_id: input.request.investigation_id,
    request_surface: input.request.request_surface,
    requested_action: input.request.requested_action,
    target_subject_type: input.request.target_subject_type,
    target_subject_id: input.request.target_subject_id,
    requester_subject_type: input.request.requester_subject_type,
    requester_subject_id: input.request.requester_subject_id,
    approver_side: input.approval.side,
    approver_subject_type: input.approval.subject_type,
    approver_subject_id: input.approval.subject_id,
    relation_type: input.approval.relation_type,
    relation_source: input.approval.relation_source,
    method: input.artifact.method,
    transport_channel: input.artifact.transport_channel,
    redaction_level: input.request.redaction_level,
    request_status: input.requestStatus,
    decision: input.decision,
    grant_ids: input.grants.map((grant) => grant.public_grant_id),
    reference: input.request.reference,
    ticket_reference: input.request.ticket_reference,
    completed_at: input.completedAt,
  };
}

export async function issueApprovalDecisionReceipt(
  env: Env,
  input: {
    artifact: ApprovalCompletionArtifact;
    request: ApprovalRequest;
    approval: ApprovalRequestApproval;
    decision: ApprovalRequestApproval['status'];
    requestStatus: ApprovalRequestStatus;
    grants: ElevationGrant[];
    completedAt?: number;
    expiresAt?: number | null;
  }
): Promise<ApprovalDecisionReceipt> {
  const receiptId = generatePublicApprovalDecisionReceiptId();
  const tenantId = input.request.tenant_id;
  const challengeStore = await getChallengeStoreByChallengeId(env, receiptId, tenantId);
  const completedAt = input.completedAt ?? Date.now();
  const upperExpiresAt = input.expiresAt ?? completedAt + DEFAULT_RECEIPT_TTL_SECONDS * 1000;
  const ttlMs = Math.max(
    1_000,
    Math.min(Math.max(1_000, upperExpiresAt - completedAt), DEFAULT_RECEIPT_TTL_SECONDS * 1000)
  );
  const ttlSeconds = Math.max(1, Math.floor(ttlMs / 1000));

  await challengeStore.storeChallengeRpc({
    id: receiptId,
    tenantId,
    type: APPROVAL_DECISION_RECEIPT_CHALLENGE_TYPE,
    userId: input.approval.subject_id ?? input.request.target_subject_id,
    challenge: receiptId,
    ttl: ttlSeconds,
    metadata: buildReceiptMetadata({
      ...input,
      completedAt,
    }),
  });

  const challenge = await challengeStore.getChallengeRpc(receiptId);
  const receipt = challenge ? toApprovalDecisionReceipt(challenge) : null;
  if (!receipt) {
    throw new Error('Failed to persist approval decision receipt');
  }

  return receipt;
}

export async function getApprovalDecisionReceipt(
  env: Env,
  receiptId: string,
  tenantId: string
): Promise<ApprovalDecisionReceipt | null> {
  const challengeStore = await getChallengeStoreByChallengeId(env, receiptId, tenantId);
  const challenge = await challengeStore.getChallengeRpc(receiptId);
  return challenge ? toApprovalDecisionReceipt(challenge) : null;
}
