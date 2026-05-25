import type { Context } from 'hono';
import type {
  ApprovalCompletionArtifact,
  ApprovalRequest,
  ApprovalRequestApproval,
  Env,
} from '@authrim/ar-lib-core';
import {
  generatePublicApprovalCompletionArtifactId,
  getChallengeStoreByChallengeId,
  type Challenge,
} from '@authrim/ar-lib-core';

const APPROVAL_COMPLETION_CHALLENGE_TYPE = 'approval_completion';
const DEFAULT_ARTIFACT_TTL_SECONDS = 10 * 60;

type AppContext = Context<any, any, any>;

function toApprovalCompletionArtifact(challenge: Challenge): ApprovalCompletionArtifact | null {
  if (challenge.type !== APPROVAL_COMPLETION_CHALLENGE_TYPE) {
    return null;
  }

  const metadata = challenge.metadata as Record<string, unknown> | undefined;
  if (!metadata) {
    return null;
  }

  return {
    artifact_id: challenge.id,
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
    method:
      (metadata.method as ApprovalCompletionArtifact['method'] | undefined) ?? 'portal_confirm',
    transport_channel:
      typeof metadata.transport_channel === 'string' ? metadata.transport_channel : null,
    redaction_level: metadata.redaction_level as ApprovalRequest['redaction_level'],
    policy_preset: String(metadata.policy_preset ?? ''),
    reuse_scope: metadata.reuse_scope as ApprovalRequest['reuse_scope'],
    partial_access_allowed: Boolean(metadata.partial_access_allowed),
    reference:
      typeof metadata.reference === 'object' && metadata.reference !== null
        ? (metadata.reference as ApprovalRequest['reference'])
        : null,
    ticket_reference:
      typeof metadata.ticket_reference === 'object' && metadata.ticket_reference !== null
        ? (metadata.ticket_reference as ApprovalRequest['ticket_reference'])
        : null,
    expires_at: challenge.expiresAt,
    created_at: challenge.createdAt,
    consumed: challenge.consumed,
  };
}

function buildArtifactMetadata(
  request: ApprovalRequest,
  approval: ApprovalRequestApproval,
  method: NonNullable<ApprovalRequestApproval['method']>,
  transportChannel: string | null
): Record<string, unknown> {
  return {
    tenant_id: request.tenant_id,
    request_id: request.public_request_id,
    approval_id: approval.id,
    step_key: approval.step_key,
    investigation_id: request.investigation_id,
    request_surface: request.request_surface,
    requested_action: request.requested_action,
    target_subject_type: request.target_subject_type,
    target_subject_id: request.target_subject_id,
    requester_subject_type: request.requester_subject_type,
    requester_subject_id: request.requester_subject_id,
    approver_side: approval.side,
    approver_subject_type: approval.subject_type,
    approver_subject_id: approval.subject_id,
    relation_type: approval.relation_type,
    relation_source: approval.relation_source,
    method,
    transport_channel: transportChannel,
    redaction_level: request.redaction_level,
    policy_preset: request.policy_preset,
    reuse_scope: request.reuse_scope,
    partial_access_allowed: request.partial_access_allowed,
    reference: request.reference,
    ticket_reference: request.ticket_reference,
  };
}

export async function issueApprovalCompletionArtifact(
  c: AppContext,
  input: {
    request: ApprovalRequest;
    approval: ApprovalRequestApproval;
    method: NonNullable<ApprovalRequestApproval['method']>;
    transportChannel?: string | null;
    expiresAt?: number | null;
  }
): Promise<ApprovalCompletionArtifact> {
  const artifactId = generatePublicApprovalCompletionArtifactId();
  const tenantId = input.request.tenant_id;
  const challengeStore = await getChallengeStoreByChallengeId(c.env, artifactId, tenantId);
  const now = Date.now();
  const upperExpiresAt = input.expiresAt ?? input.approval.expires_at ?? input.request.expires_at;
  const ttlMs = Math.max(
    1_000,
    Math.min(Math.max(1_000, upperExpiresAt - now), DEFAULT_ARTIFACT_TTL_SECONDS * 1000)
  );
  const ttlSeconds = Math.max(1, Math.floor(ttlMs / 1000));

  await challengeStore.storeChallengeRpc({
    id: artifactId,
    tenantId,
    type: APPROVAL_COMPLETION_CHALLENGE_TYPE,
    userId: input.approval.subject_id ?? input.request.target_subject_id,
    challenge: artifactId,
    ttl: ttlSeconds,
    metadata: buildArtifactMetadata(
      input.request,
      input.approval,
      input.method,
      input.transportChannel ?? null
    ),
  });

  const challenge = await challengeStore.getChallengeRpc(artifactId);
  if (!challenge) {
    throw new Error('Failed to persist approval completion artifact');
  }

  const artifact = toApprovalCompletionArtifact(challenge);
  if (!artifact) {
    throw new Error('Invalid approval completion artifact state');
  }

  return artifact;
}

export async function getApprovalCompletionArtifact(
  env: Env,
  artifactId: string,
  tenantId: string
): Promise<ApprovalCompletionArtifact | null> {
  const challengeStore = await getChallengeStoreByChallengeId(env, artifactId, tenantId);
  const challenge = await challengeStore.getChallengeRpc(artifactId);
  return challenge ? toApprovalCompletionArtifact(challenge) : null;
}

export async function consumeApprovalCompletionArtifact(
  env: Env,
  artifactId: string,
  tenantId: string
): Promise<ApprovalCompletionArtifact> {
  const challengeStore = await getChallengeStoreByChallengeId(env, artifactId, tenantId);
  await challengeStore.consumeChallengeRpc({
    id: artifactId,
    tenantId,
    type: APPROVAL_COMPLETION_CHALLENGE_TYPE,
    challenge: artifactId,
  });

  const consumed = await challengeStore.getChallengeRpc(artifactId);
  const artifact = consumed ? toApprovalCompletionArtifact(consumed) : null;
  if (!artifact) {
    throw new Error('Invalid approval completion artifact state');
  }
  return artifact;
}
