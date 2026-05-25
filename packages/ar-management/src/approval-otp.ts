import type { Env, ApprovalTransportMethod } from '@authrim/ar-lib-core';
import { getChallengeStoreByChallengeId } from '@authrim/ar-lib-core';

const APPROVAL_OTP_TTL_SECONDS = 5 * 60;
const APPROVAL_OTP_INVALID_ATTEMPT_PREFIX = 'approval_otp:attempts:';
const APPROVAL_OTP_MAX_INVALID_ATTEMPTS = 5;

interface ApprovalOtpAttemptState {
  count: number;
  last_attempt_at: number;
}

function normalizeTarget(target: string): string {
  return target.trim().toLowerCase();
}

function generateApprovalOtpCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return (array[0] % 1000000).toString().padStart(6, '0');
}

async function hashApprovalOtp(
  code: string,
  target: string,
  artifactId: string,
  issuedAt: number,
  secret: string
): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${code}:${normalizeTarget(target)}:${artifactId}:${issuedAt}`);
  const keyData = encoder.encode(secret);

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, data);
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function verifyApprovalOtpHash(
  code: string,
  target: string,
  artifactId: string,
  issuedAt: number,
  storedHash: string,
  secret: string
): Promise<boolean> {
  const computedHash = await hashApprovalOtp(code, target, artifactId, issuedAt, secret);
  if (computedHash.length !== storedHash.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < computedHash.length; i++) {
    result |= computedHash.charCodeAt(i) ^ storedHash.charCodeAt(i);
  }
  return result === 0;
}

async function hashTarget(target: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(normalizeTarget(target));
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function getApprovalOtpAttemptKey(artifactId: string): string {
  return `${APPROVAL_OTP_INVALID_ATTEMPT_PREFIX}${artifactId}`;
}

async function loadApprovalOtpAttemptState(
  env: Pick<Env, 'AUTHRIM_CONFIG'>,
  artifactId: string
): Promise<ApprovalOtpAttemptState | null> {
  const raw = await env.AUTHRIM_CONFIG?.get(getApprovalOtpAttemptKey(artifactId));
  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw) as Partial<ApprovalOtpAttemptState>;
  if (typeof parsed.count !== 'number' || typeof parsed.last_attempt_at !== 'number') {
    return null;
  }

  return {
    count: parsed.count,
    last_attempt_at: parsed.last_attempt_at,
  };
}

async function saveApprovalOtpAttemptState(
  env: Pick<Env, 'AUTHRIM_CONFIG'>,
  artifactId: string,
  state: ApprovalOtpAttemptState,
  expiresAt: number
): Promise<void> {
  if (!env.AUTHRIM_CONFIG) {
    return;
  }
  const ttlSeconds = Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000));
  await env.AUTHRIM_CONFIG.put(getApprovalOtpAttemptKey(artifactId), JSON.stringify(state), {
    expirationTtl: ttlSeconds,
  });
}

async function clearApprovalOtpAttemptState(
  env: Pick<Env, 'AUTHRIM_CONFIG'>,
  artifactId: string
): Promise<void> {
  await env.AUTHRIM_CONFIG?.delete(getApprovalOtpAttemptKey(artifactId));
}

export async function issueApprovalOtpChallenge(
  env: Env,
  input: {
    tenantId: string;
    artifactId: string;
    method: Extract<ApprovalTransportMethod, 'email_otp' | 'sms_otp'>;
    target: string;
    approverSubjectId: string | null;
  }
): Promise<{
  code: string;
  expiresAt: number;
}> {
  const code = generateApprovalOtpCode();
  const issuedAt = Date.now();
  const secret = env.OTP_HMAC_SECRET || env.ISSUER_URL;
  const normalizedTarget = normalizeTarget(input.target);
  const challengeStore = await getChallengeStoreByChallengeId(
    env,
    input.artifactId,
    input.tenantId
  );
  const [codeHash, targetHash] = await Promise.all([
    hashApprovalOtp(code, normalizedTarget, input.artifactId, issuedAt, secret),
    hashTarget(normalizedTarget),
  ]);

  await challengeStore.storeChallengeRpc({
    id: `approval_otp:${input.artifactId}`,
    tenantId: input.tenantId,
    type: 'email_code',
    userId: input.approverSubjectId ?? input.artifactId,
    challenge: codeHash,
    ttl: APPROVAL_OTP_TTL_SECONDS,
    email: input.method === 'email_otp' ? normalizedTarget : undefined,
    metadata: {
      target_hash: targetHash,
      issued_at: issuedAt,
      purpose: 'approval_completion',
      method: input.method,
      approval_artifact_id: input.artifactId,
      target: normalizedTarget,
    },
  });
  await clearApprovalOtpAttemptState(env, input.artifactId);

  return {
    code,
    expiresAt: issuedAt + APPROVAL_OTP_TTL_SECONDS * 1000,
  };
}

export async function verifyApprovalOtpChallenge(
  env: Env,
  input: {
    tenantId: string;
    artifactId: string;
    code: string;
    target: string;
  }
): Promise<{
  verifiedAt: number;
}> {
  const challengeStore = await getChallengeStoreByChallengeId(
    env,
    input.artifactId,
    input.tenantId
  );
  const challenge = await challengeStore.getChallengeRpc(`approval_otp:${input.artifactId}`);
  if (!challenge || challenge.type !== 'email_code' || challenge.consumed) {
    throw new Error('Invalid approval OTP challenge');
  }

  const issuedAt = Number(challenge.metadata?.issued_at ?? 0);
  const storedTarget = String(challenge.metadata?.target ?? '');
  const expectedArtifactId = String(challenge.metadata?.approval_artifact_id ?? '');
  const secret = env.OTP_HMAC_SECRET || env.ISSUER_URL;
  if (!issuedAt || !storedTarget || expectedArtifactId !== input.artifactId) {
    throw new Error('Invalid approval OTP challenge');
  }

  const valid = await verifyApprovalOtpHash(
    input.code,
    normalizeTarget(input.target),
    input.artifactId,
    issuedAt,
    challenge.challenge,
    secret
  );
  if (!valid || storedTarget !== normalizeTarget(input.target)) {
    const currentAttempts = await loadApprovalOtpAttemptState(env, input.artifactId);
    const nextState: ApprovalOtpAttemptState = {
      count: (currentAttempts?.count ?? 0) + 1,
      last_attempt_at: Date.now(),
    };
    if (nextState.count >= APPROVAL_OTP_MAX_INVALID_ATTEMPTS) {
      await challengeStore.consumeChallengeRpc({
        id: `approval_otp:${input.artifactId}`,
        tenantId: input.tenantId,
        type: 'email_code',
        challenge: challenge.challenge,
      });
      await clearApprovalOtpAttemptState(env, input.artifactId);
    } else {
      await saveApprovalOtpAttemptState(env, input.artifactId, nextState, challenge.expiresAt);
    }
    throw new Error('Invalid approval OTP code');
  }

  await challengeStore.consumeChallengeRpc({
    id: `approval_otp:${input.artifactId}`,
    tenantId: input.tenantId,
    type: 'email_code',
    challenge: challenge.challenge,
  });
  await clearApprovalOtpAttemptState(env, input.artifactId);

  return {
    verifiedAt: Date.now(),
  };
}
