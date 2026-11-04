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

  const metadata = challenge.metadata;
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

/**
 * A reference for an artifact that is safe to show and store (notification ids, evidence): a
 * one-way hash, so anyone reading it cannot recover the artifact, which approves or verifies.
 */
export async function approvalArtifactReference(artifactId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(artifactId));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'));
  return `apref_${hex.join('').slice(0, 32)}`;
}

const APPROVAL_COMPLETION_PROOF_TYPE = 'approval_completion_proof';

/** What a completion endpoint verified for an artifact (passkey, OTP or reauth). */
export interface ApprovalCompletionProof {
  method: ApprovalCompletionArtifact['method'];
  actor_subject_type: ApprovalCompletionArtifact['approver_subject_type'];
  actor_subject_id: string | null;
  verified_at: number;
  metadata: Record<string, unknown>;
}

/** The ChallengeStore calls a completion proof needs, typed for this module. */
interface ApprovalCompletionProofStore {
  storeChallengeRpc(request: {
    id: string;
    tenantId: string;
    type: string;
    userId: string;
    challenge: string;
    ttl: number;
    metadata: Record<string, unknown>;
  }): Promise<unknown>;
  getChallengeRpc(id: string): Promise<{
    type: string;
    tenantId: string;
    challenge: string;
    consumed?: boolean;
    expiresAt: number;
    metadata?: Record<string, unknown>;
  } | null>;
  deleteChallengeRpc(id: string): Promise<unknown>;
}

async function getApprovalCompletionProofStore(
  env: Env,
  proofId: string,
  tenantId: string
): Promise<ApprovalCompletionProofStore> {
  const store: unknown = await getChallengeStoreByChallengeId(env, proofId, tenantId);
  return store as ApprovalCompletionProofStore;
}

function approvalCompletionProofId(artifactId: string): string {
  return `${artifactId}.proof`;
}

/**
 * Record, server-side, that the artifact's completion method was verified. `/complete` accepts a
 * step-up decision only by consuming this record: a completion assertion sent by the client is
 * never evidence on its own.
 */
export async function recordApprovalCompletionProof(
  env: Env,
  artifact: ApprovalCompletionArtifact,
  proof: ApprovalCompletionProof
): Promise<void> {
  const proofId = approvalCompletionProofId(artifact.artifact_id);
  const challengeStore = await getApprovalCompletionProofStore(env, proofId, artifact.tenant_id);
  await challengeStore.storeChallengeRpc({
    id: proofId,
    tenantId: artifact.tenant_id,
    type: APPROVAL_COMPLETION_PROOF_TYPE,
    userId: proof.actor_subject_id ?? artifact.approver_subject_id ?? '',
    challenge: artifact.artifact_id,
    ttl: Math.max(1, Math.floor((artifact.expires_at - Date.now()) / 1000)),
    metadata: { ...proof },
  });
}

/**
 * The recorded proof of an artifact, without consuming it: the artifact's own consumption is the
 * single-use step, so a failure before it leaves the proof for a retry. Null when none is live.
 */
export async function findApprovalCompletionProof(
  env: Env,
  artifactId: string,
  tenantId: string
): Promise<ApprovalCompletionProof | null> {
  const proofId = approvalCompletionProofId(artifactId);
  const challengeStore = await getApprovalCompletionProofStore(env, proofId, tenantId);
  const stored = await challengeStore.getChallengeRpc(proofId);
  if (
    !stored ||
    stored.type !== APPROVAL_COMPLETION_PROOF_TYPE ||
    stored.tenantId !== tenantId ||
    stored.challenge !== artifactId ||
    stored.consumed ||
    stored.expiresAt <= Date.now()
  ) {
    return null;
  }
  const metadata = stored.metadata;
  if (
    !metadata ||
    typeof metadata.method !== 'string' ||
    typeof metadata.verified_at !== 'number'
  ) {
    return null;
  }
  return {
    method: metadata.method as ApprovalCompletionProof['method'],
    actor_subject_type:
      metadata.actor_subject_type as ApprovalCompletionProof['actor_subject_type'],
    actor_subject_id:
      typeof metadata.actor_subject_id === 'string' ? metadata.actor_subject_id : null,
    verified_at: metadata.verified_at,
    metadata:
      typeof metadata.metadata === 'object' && metadata.metadata !== null
        ? (metadata.metadata as Record<string, unknown>)
        : {},
  };
}

/** Drop an artifact's proof once the artifact was consumed (it can no longer be used anyway). */
export async function discardApprovalCompletionProof(
  env: Env,
  artifactId: string,
  tenantId: string
): Promise<void> {
  const proofId = approvalCompletionProofId(artifactId);
  const challengeStore = await getApprovalCompletionProofStore(env, proofId, tenantId);
  await challengeStore.deleteChallengeRpc(proofId);
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
