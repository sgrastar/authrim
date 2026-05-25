import type {
  ApprovalCompletionArtifact,
  ApprovalRequest,
  ApprovalRequestApproval,
  CIBARequestMetadata,
  Env,
} from '@authrim/ar-lib-core';
import {
  CIBA_DEFAULT_INTERVAL_SECONDS,
  generateAuthReqId,
  generateCIBAUserCode,
  getCIBARequestStoreById,
  getCIBARequestStoreForNewRequest,
  timingSafeEqual,
} from '@authrim/ar-lib-core';

const APPROVAL_CIBA_STATE_PREFIX = 'approval_ciba:artifact:';

interface ApprovalCibaStoredState {
  auth_req_id: string;
  created_at: number;
  expires_at: number;
  status: 'pending' | 'approved' | 'denied';
  decision_at?: number | null;
}

export interface ApprovalCibaStartResult {
  authReqId: string;
  expiresAt: number;
  createdAt: number;
  interval: number;
  userCode: string | null;
  reused: boolean;
}

export interface ApprovalCibaStatusResult {
  authReqId: string;
  createdAt: number;
  expiresAt: number;
  interval: number;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  userCode: string | null;
  decisionAt: number | null;
}

function getStateKey(artifactId: string): string {
  return `${APPROVAL_CIBA_STATE_PREFIX}${artifactId}`;
}

function normalizeUserCode(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, '');
}

async function loadStoredState(
  env: Env,
  artifactId: string
): Promise<ApprovalCibaStoredState | null> {
  const raw = await env.AUTHRIM_CONFIG?.get(getStateKey(artifactId));
  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw) as ApprovalCibaStoredState;
  if (!parsed.auth_req_id || !parsed.expires_at || !parsed.created_at) {
    return null;
  }
  return parsed;
}

async function saveStoredState(
  env: Env,
  artifactId: string,
  state: ApprovalCibaStoredState
): Promise<void> {
  if (!env.AUTHRIM_CONFIG) {
    throw new Error('AUTHRIM_CONFIG is required for approval CIBA state');
  }

  const ttlSeconds = Math.max(1, Math.ceil((state.expires_at - Date.now()) / 1000));
  await env.AUTHRIM_CONFIG.put(getStateKey(artifactId), JSON.stringify(state), {
    expirationTtl: ttlSeconds,
  });
}

async function getMetadataByAuthReqId(
  env: Env,
  tenantId: string,
  authReqId: string
): Promise<CIBARequestMetadata | null> {
  const { stub } = getCIBARequestStoreById(env, authReqId, tenantId);
  const response = await stub.fetch(
    new Request('https://internal/get-by-auth-req-id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_req_id: authReqId }),
    })
  );
  if (!response.ok) {
    return null;
  }
  return (await response.json()) as CIBARequestMetadata | null;
}

function buildPendingMetadata(input: {
  artifact: ApprovalCompletionArtifact;
  request: ApprovalRequest;
  approval: ApprovalRequestApproval;
  authReqId: string;
  createdAt: number;
  expiresAt: number;
}): CIBARequestMetadata {
  const loginHint =
    input.approval.subject_id ??
    input.approval.transport_channel ??
    input.artifact.approver_subject_id ??
    input.artifact.target_subject_id;

  return {
    auth_req_id: input.authReqId,
    client_id: `authrim-approval:${input.request.request_surface}`,
    scope: 'approval_completion',
    login_hint: loginHint,
    binding_message: `${input.request.request_surface}/${input.request.requested_action} (${input.request.investigation_id})`,
    user_code: generateCIBAUserCode(),
    requested_expiry: Math.max(1, Math.floor((input.expiresAt - input.createdAt) / 1000)),
    status: 'pending',
    delivery_mode: 'poll',
    created_at: input.createdAt,
    expires_at: input.expiresAt,
    interval: CIBA_DEFAULT_INTERVAL_SECONDS,
  };
}

export async function startApprovalCibaRequest(input: {
  env: Env;
  tenantId: string;
  artifact: ApprovalCompletionArtifact;
  request: ApprovalRequest;
  approval: ApprovalRequestApproval;
}): Promise<ApprovalCibaStartResult> {
  const { env, tenantId, artifact } = input;

  const existing = await loadStoredState(env, artifact.artifact_id);
  if (existing && existing.expires_at > Date.now()) {
    const existingMetadata = await getMetadataByAuthReqId(env, tenantId, existing.auth_req_id);
    if (existingMetadata && existingMetadata.status === 'pending') {
      return {
        authReqId: existing.auth_req_id,
        createdAt: existing.created_at,
        expiresAt: existing.expires_at,
        interval: existingMetadata.interval,
        userCode: existingMetadata.user_code ?? null,
        reused: true,
      };
    }
  }

  const rawAuthReqId = generateAuthReqId();
  const createdAt = Date.now();
  const expiresAt = Math.min(artifact.expires_at, createdAt + 10 * 60 * 1000);
  const { stub, cibaId } = await getCIBARequestStoreForNewRequest(
    env,
    tenantId,
    `approval:${artifact.approver_side}`,
    rawAuthReqId
  );
  const metadata = buildPendingMetadata({
    ...input,
    authReqId: cibaId,
    createdAt,
    expiresAt,
  });

  await stub.fetch(
    new Request('https://internal/store', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    })
  );

  await saveStoredState(env, artifact.artifact_id, {
    auth_req_id: cibaId,
    created_at: createdAt,
    expires_at: expiresAt,
    status: 'pending',
    decision_at: null,
  });

  return {
    authReqId: cibaId,
    createdAt,
    expiresAt,
    interval: metadata.interval,
    userCode: metadata.user_code ?? null,
    reused: false,
  };
}

export async function getApprovalCibaStatus(input: {
  env: Env;
  tenantId: string;
  artifactId: string;
}): Promise<ApprovalCibaStatusResult | null> {
  const stored = await loadStoredState(input.env, input.artifactId);
  if (!stored) {
    return null;
  }

  const metadata = await getMetadataByAuthReqId(input.env, input.tenantId, stored.auth_req_id);
  if (!metadata) {
    return null;
  }

  return {
    authReqId: stored.auth_req_id,
    createdAt: stored.created_at,
    expiresAt: stored.expires_at,
    interval: metadata.interval,
    status: metadata.status,
    userCode: metadata.user_code ?? null,
    decisionAt: stored.decision_at ?? null,
  };
}

export async function respondToApprovalCibaRequest(input: {
  env: Env;
  tenantId: string;
  artifactId: string;
  actorSubjectId: string;
  authReqId: string;
  userCode: string;
  decision: 'approved' | 'denied';
}): Promise<ApprovalCibaStatusResult> {
  const stored = await loadStoredState(input.env, input.artifactId);
  if (!stored) {
    throw new Error('Approval CIBA request not found');
  }
  if (stored.auth_req_id !== input.authReqId) {
    throw new Error('Approval CIBA request mismatch');
  }

  const { stub } = getCIBARequestStoreById(input.env, stored.auth_req_id, input.tenantId);
  const metadata = await getMetadataByAuthReqId(input.env, input.tenantId, stored.auth_req_id);
  if (!metadata) {
    throw new Error('Approval CIBA metadata not found');
  }
  const expectedUserCode = normalizeUserCode(metadata.user_code ?? '');
  const providedUserCode = normalizeUserCode(input.userCode);
  if (!expectedUserCode || !timingSafeEqual(providedUserCode, expectedUserCode)) {
    throw new Error('Invalid approval CIBA verification code');
  }
  const endpoint = input.decision === 'approved' ? 'approve' : 'deny';
  const body =
    input.decision === 'approved'
      ? {
          auth_req_id: stored.auth_req_id,
          user_id: input.actorSubjectId,
          sub: input.actorSubjectId,
          nonce: input.artifactId,
        }
      : {
          auth_req_id: stored.auth_req_id,
        };

  await stub.fetch(
    new Request(`https://internal/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

  const nextState: ApprovalCibaStoredState = {
    ...stored,
    status: input.decision,
    decision_at: Date.now(),
  };
  await saveStoredState(input.env, input.artifactId, nextState);

  const refreshedMetadata = await getMetadataByAuthReqId(
    input.env,
    input.tenantId,
    stored.auth_req_id
  );
  return {
    authReqId: stored.auth_req_id,
    createdAt: stored.created_at,
    expiresAt: stored.expires_at,
    interval: refreshedMetadata?.interval ?? CIBA_DEFAULT_INTERVAL_SECONDS,
    status: input.decision,
    userCode: refreshedMetadata?.user_code ?? null,
    decisionAt: nextState.decision_at ?? null,
  };
}
