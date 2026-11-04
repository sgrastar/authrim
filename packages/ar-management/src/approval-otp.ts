import type { Env, ApprovalTransportMethod } from '@authrim/ar-lib-core';
import { buildDOKey, getChallengeStoreByChallengeId } from '@authrim/ar-lib-core';

const APPROVAL_OTP_TTL_SECONDS = 5 * 60;
const APPROVAL_OTP_MAX_INVALID_ATTEMPTS = 5;

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

/**
 * Counts an attempt at the challenge, atomically (a KV read-modify-write would let parallel
 * guesses read the same count), before the code is checked: when the counter cannot answer, the
 * attempt fails and no code is checked. Keyed by the issued challenge, so a new code starts from
 * zero. Returns the attempts so far.
 */
async function countApprovalOtpAttempt(
  env: Pick<Env, 'RATE_LIMITER'>,
  tenantId: string,
  artifactId: string,
  issuedAt: number,
  expiresAt: number
): Promise<number> {
  const counter = env.RATE_LIMITER.get(
    env.RATE_LIMITER.idFromName(buildDOKey('rate-limit', 'approval-otp', tenantId))
  );
  const result = await counter.incrementRpc(`${artifactId}:${issuedAt}`, {
    windowSeconds: Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)),
    maxRequests: APPROVAL_OTP_MAX_INVALID_ATTEMPTS,
  });
  return result.current;
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

  const consumeChallenge = async (): Promise<void> => {
    await challengeStore.consumeChallengeRpc({
      id: `approval_otp:${input.artifactId}`,
      tenantId: input.tenantId,
      type: 'email_code',
      challenge: challenge.challenge,
    });
  };
  const attempts = await countApprovalOtpAttempt(
    env,
    input.tenantId,
    input.artifactId,
    issuedAt,
    challenge.expiresAt
  );
  if (attempts > APPROVAL_OTP_MAX_INVALID_ATTEMPTS) {
    await consumeChallenge();
    throw new Error('Invalid approval OTP code');
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
    // The last attempt allowed was a wrong code: the challenge ends.
    if (attempts >= APPROVAL_OTP_MAX_INVALID_ATTEMPTS) {
      await consumeChallenge();
    }
    throw new Error('Invalid approval OTP code');
  }

  await consumeChallenge();

  return {
    verifiedAt: Date.now(),
  };
}
