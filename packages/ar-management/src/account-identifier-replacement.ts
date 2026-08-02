import type { Context } from 'hono';
import {
  CanonicalRuntimeUserStore,
  createAuthContextFromHono,
  createLookupBlindIndexes,
  createPIIContextFromHono,
  getLogger,
  getTenantIdFromContext,
  normalizeLookupEmail,
  produceNotificationDelivery,
  type Env,
} from '@authrim/ar-lib-core';
import { requireAccountSession, type AccountSession } from './account-page';
import { createLookupBucketWriteResolver } from './lookup-bucket-write-route';
import { loadLookupHmacRuntimeKeys } from './lookup-hmac-runtime';
import {
  IdentifierReplacementCoordinator,
  isPermanentIdentifierReplacementFailure,
} from './identifier-replacement-coordinator';
import { revokeIdentifierReplacementCredentials } from './identifier-replacement-credential-revocation';
import { IdentifierReplacementOperationRepository } from './identifier-replacement-operation';

const REAUTH_TTL_SECONDS = 5 * 60;
const CHALLENGE_TTL_SECONDS = 10 * 60;
const CONSUMED_CHALLENGE_RECOVERY_TTL_SECONDS = 2 * 60 * 60;
const ATTEMPT_LIMIT = 5;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{8,200}$/u;

interface ChallengeRow {
  tenant_id: string;
  account_id: string;
  normalized_value_json: string;
  value_sha256: string;
  otp_verifier: string;
  delivery_state: string;
  attempt_count: number;
  attempt_limit: number;
  expires_at: number;
  consumed_at: number | null;
  initiating_session_ref: string;
  recent_reauth_verified_at: number;
}

interface ExistingOperationRow {
  operation_id: string;
  idempotency_key_sha256: string;
  state: string;
}

function noStore(c: Context<{ Bindings: Env }>): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

function otpSecret(env: Env): string {
  const value = env.OTP_HMAC_SECRET;
  if (!value || new TextEncoder().encode(value).byteLength < 32) {
    throw new Error('identifier_replacement_otp_unavailable');
  }
  return value;
}

function randomOtpCode(): string {
  const bytes = new Uint8Array(6);
  const digits: number[] = [];
  while (digits.length < 6) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= 250) continue;
      digits.push(Math.floor(byte / 25));
      if (digits.length === 6) break;
    }
  }
  return digits.join('');
}

function recentlyAuthenticated(session: AccountSession, now: number): boolean {
  return session.authTime <= now && now < session.authTime + REAUTH_TTL_SECONDS;
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function runtimeUser(c: Context<{ Bindings: Env }>, tenantId: string, accountId: string) {
  const auth = createAuthContextFromHono(c, tenantId);
  const pii = createPIIContextFromHono(c, tenantId);
  const store = new CanonicalRuntimeUserStore({
    coreAdapter: auth.coreAdapter,
    piiAdapter: pii.defaultPiiAdapter,
    tenantId,
  });
  return { auth, pii, user: await store.findById(accountId) };
}

async function coordinatorFor(c: Context<{ Bindings: Env }>, tenantId: string) {
  const auth = createAuthContextFromHono(c, tenantId);
  const pii = createPIIContextFromHono(c, tenantId);
  const lookupForBucket = await createLookupBucketWriteResolver(c.env);
  return new IdentifierReplacementCoordinator({
    pii: pii.defaultPiiAdapter,
    lookupForBucket,
    revokeCredentials: (input) =>
      revokeIdentifierReplacementCredentials({ env: c.env, core: auth.coreAdapter, ...input }),
    enqueueOldIdentifierNotification: async (input) => {
      await produceNotificationDelivery(c.env, {
        owner: { owner: 'tenant', tenantId: input.tenantId },
        intentId: `identifier-replaced:${input.operationId}`,
        outboxId: `notification:${input.operationId}`,
        notificationKind: 'account.identifier-replaced',
        idempotencyKey: `identifier-replaced:${input.operationId}`,
        expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
        payload: {
          channel: 'email',
          to: input.oldValue,
          from: c.env.EMAIL_FROM || 'noreply@authrim.dev',
          subject: 'Your account email address was changed',
          body: 'The email address for your account was changed. Contact your administrator if you did not request this change.',
        },
      });
    },
  });
}

export async function startAccountIdentifierReplacementHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  noStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) return accountSession;
  const now = Math.floor(Date.now() / 1000);
  if (!recentlyAuthenticated(accountSession, now)) {
    return c.json(
      {
        error: 'reauthentication_required',
        error_description: 'Recent authentication is required',
        reauth_required: true,
      },
      403
    );
  }
  let body: { email?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: 'invalid_request', error_description: 'Request body must be JSON' },
      400
    );
  }
  if (typeof body.email !== 'string' || body.email.length > 320) {
    return c.json(
      { error: 'invalid_request', error_description: 'A valid email is required' },
      400
    );
  }
  let newEmail: string;
  try {
    newEmail = normalizeLookupEmail(body.email);
  } catch {
    return c.json(
      { error: 'invalid_request', error_description: 'A valid email is required' },
      400
    );
  }
  const tenantId = getTenantIdFromContext(c);
  const { pii, user } = await runtimeUser(c, tenantId, accountSession.userId);
  if (!user?.email) {
    return c.json({ error: 'not_found', error_description: 'Account email was not found' }, 404);
  }
  if (normalizeLookupEmail(user.email) === newEmail) {
    return c.json({ error: 'invalid_request', error_description: 'Email is unchanged' }, 400);
  }
  const secret = otpSecret(c.env);
  const challengeId = `identifier-replacement-${crypto.randomUUID()}`;
  const code = randomOtpCode();
  const verifier = await hmac(`${challengeId}\0${code}`, secret);
  const newValueHash = await sha256(newEmail);
  await pii.defaultPiiAdapter.execute(
    `INSERT INTO identity_identifier_replacement_challenges (
       challenge_id, tenant_id, account_id, identifier_kind, normalized_value_json,
       value_sha256, otp_verifier, delivery_state, attempt_limit, expires_at,
       initiating_session_ref, recent_reauth_verified_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'email_exact', ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    [
      challengeId,
      tenantId,
      accountSession.userId,
      JSON.stringify(newEmail),
      newValueHash,
      verifier,
      ATTEMPT_LIMIT,
      now + CHALLENGE_TTL_SECONDS,
      accountSession.sessionId,
      accountSession.authTime,
      now,
      now,
    ]
  );
  let deliveryState: 'sent' | 'failed' = 'failed';
  try {
    const delivery = await produceNotificationDelivery(c.env, {
      owner: { owner: 'tenant', tenantId },
      intentId: `identifier-replacement-otp:${challengeId}`,
      outboxId: `notification:${challengeId}`,
      notificationKind: 'account.identifier-replacement-otp',
      idempotencyKey: `identifier-replacement-otp:${challengeId}`,
      expiresAt: now + CHALLENGE_TTL_SECONDS,
      payload: {
        channel: 'email',
        to: newEmail,
        from: c.env.EMAIL_FROM || 'noreply@authrim.dev',
        subject: 'Confirm your new email address',
        body: `Your confirmation code is ${code}. It expires in 10 minutes.`,
      },
    });
    deliveryState = delivery.delivery === 'permanent_failure' ? 'failed' : 'sent';
  } catch {
    deliveryState = 'failed';
  }
  await pii.defaultPiiAdapter.execute(
    `UPDATE identity_identifier_replacement_challenges
        SET delivery_state = ?, updated_at = ?
      WHERE challenge_id = ? AND delivery_state = 'pending'`,
    [deliveryState, now, challengeId]
  );
  if (deliveryState === 'failed') {
    return c.json(
      { error: 'temporarily_unavailable', error_description: 'Email delivery failed' },
      503
    );
  }
  return c.json({ challenge_id: challengeId, expires_in: CHALLENGE_TTL_SECONDS }, 202);
}

async function recordResumeFailure(
  c: Context<{ Bindings: Env }>,
  input: { operationId: string; tenantId: string; accountId: string; leaseOwner: string },
  now: number,
  error: unknown
): Promise<void> {
  try {
    const pii = createPIIContextFromHono(c, input.tenantId);
    if (isPermanentIdentifierReplacementFailure(error)) {
      const operation = await pii.defaultPiiAdapter.queryOne<{ state: string }>(
        `SELECT state FROM identity_identifier_replacement_operations WHERE operation_id = ?`,
        [input.operationId],
        { consistencyClass: 'primary_required' }
      );
      const nextState =
        operation?.state === 'directory_pending' ||
        operation?.state === 'authoritative_switch_pending'
          ? 'canceled'
          : 'blocked_forward_repair';
      await pii.defaultPiiAdapter.batch([
        {
          sql: `UPDATE identity_identifier_replacement_operations
                   SET state = ?, error_code = 'identifier_replacement_permanent_failure',
                       next_attempt_at = NULL, updated_at = ?
                 WHERE operation_id = ?
                   AND state NOT IN ('completed', 'canceled', 'blocked_forward_repair')`,
          params: [nextState, now, input.operationId],
        },
        {
          sql: `UPDATE identity_identifier_replacement_outbox
                   SET status = 'blocked', lease_owner = NULL, lease_expires_at = NULL,
                       next_attempt_at = NULL,
                       error_code = 'identifier_replacement_permanent_failure', updated_at = ?
                 WHERE operation_id = ? AND status = 'leased' AND lease_owner = ?`,
          params: [now, input.operationId, input.leaseOwner],
        },
      ]);
      return;
    }
    await pii.defaultPiiAdapter.batch([
      {
        sql: `UPDATE identity_identifier_replacement_operations
                 SET attempt_count = attempt_count + 1, next_attempt_at = ?,
                     error_code = 'identifier_replacement_retryable', updated_at = ?
               WHERE operation_id = ? AND tenant_id = ? AND account_id = ?
                 AND state NOT IN ('completed', 'canceled', 'blocked_forward_repair')`,
        params: [now + 30, now, input.operationId, input.tenantId, input.accountId],
      },
      {
        sql: `UPDATE identity_identifier_replacement_outbox
                 SET status = 'retry', lease_owner = NULL, lease_expires_at = NULL,
                     next_attempt_at = ?,
                     error_code = 'identifier_replacement_retryable', updated_at = ?
               WHERE operation_id = ? AND status = 'leased' AND lease_owner = ?`,
        params: [now + 30, now, input.operationId, input.leaseOwner],
      },
    ]);
  } catch {
    // The original operation remains durable and the scheduled scanner will retry it.
  }
}

export async function resumeIdentifierReplacementOperation(
  c: Context<{ Bindings: Env }>,
  input: { operationId: string; tenantId: string; accountId: string }
): Promise<string | null> {
  const now = Math.floor(Date.now() / 1000);
  const leaseOwner = `request-${crypto.randomUUID()}`;
  const pii = createPIIContextFromHono(c, input.tenantId);
  const claimed = await pii.defaultPiiAdapter.execute(
    `UPDATE identity_identifier_replacement_outbox
        SET status = 'leased', attempt_count = attempt_count + 1,
            lease_owner = ?, lease_expires_at = ?, next_attempt_at = NULL,
            error_code = NULL, updated_at = ?
      WHERE operation_id = ? AND (
        (status IN ('pending', 'retry') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
      ) AND EXISTS (
        SELECT 1 FROM identity_identifier_replacement_operations operation
         WHERE operation.operation_id = identity_identifier_replacement_outbox.operation_id
           AND operation.retry_budget_expires_at > ?
           AND operation.state NOT IN ('completed', 'canceled', 'blocked_forward_repair')
      )`,
    [leaseOwner, now + 120, now, input.operationId, now, now, now]
  );
  if (claimed.rowsAffected !== 1) return null;
  try {
    return (await (await coordinatorFor(c, input.tenantId)).resume(input)).state;
  } catch (error) {
    await recordResumeFailure(c, { ...input, leaseOwner }, now, error);
    getLogger(c)
      .module('ACCOUNT-IDENTIFIER-REPLACEMENT')
      .warn('Identifier replacement queued for forward repair', {
        action: 'identifier_replacement_resume',
        operationId: input.operationId,
        errorCode: 'identifier_replacement_resume_failed',
      });
    return null;
  }
}

async function operationResponse(
  c: Context<{ Bindings: Env }>,
  input: { operationId: string; tenantId: string; accountId: string }
): Promise<Response> {
  let state = await resumeIdentifierReplacementOperation(c, input);
  if (!state) {
    const pii = createPIIContextFromHono(c, input.tenantId);
    const reflected = await pii.defaultPiiAdapter.queryOne<{ state: string }>(
      `SELECT state FROM identity_identifier_replacement_operations
        WHERE operation_id = ? AND tenant_id = ? AND account_id = ?`,
      [input.operationId, input.tenantId, input.accountId],
      { consistencyClass: 'primary_required' }
    );
    state = reflected?.state ?? 'processing';
  }
  return c.json(
    {
      operation: {
        id: input.operationId,
        state,
        status_url: `/api/account/identifier-replacements/${encodeURIComponent(input.operationId)}`,
      },
    },
    state === 'completed' ? 200 : 202
  );
}

export async function completeAccountIdentifierReplacementHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  noStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) return accountSession;
  const now = Math.floor(Date.now() / 1000);
  if (!recentlyAuthenticated(accountSession, now)) {
    return c.json(
      {
        error: 'reauthentication_required',
        error_description: 'Recent authentication is required',
      },
      403
    );
  }
  let body: { challenge_id?: unknown; code?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: 'invalid_request', error_description: 'Request body must be JSON' },
      400
    );
  }
  if (
    typeof body.challenge_id !== 'string' ||
    typeof body.code !== 'string' ||
    !/^identifier-replacement-[a-f0-9-]{36}$/u.test(body.challenge_id) ||
    !/^\d{6}$/u.test(body.code)
  ) {
    return c.json(
      { error: 'invalid_request', error_description: 'challenge_id and 6 digit code are required' },
      400
    );
  }
  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return c.json(
      { error: 'invalid_request', error_description: 'A valid Idempotency-Key is required' },
      400
    );
  }
  const tenantId = getTenantIdFromContext(c);
  const pii = createPIIContextFromHono(c, tenantId);
  const idempotencyKeySha256 = await sha256(idempotencyKey);
  const existing = await pii.defaultPiiAdapter.queryOne<ExistingOperationRow>(
    `SELECT operation_id, idempotency_key_sha256, state
       FROM identity_identifier_replacement_operations
      WHERE challenge_id = ? AND tenant_id = ? AND account_id = ?`,
    [body.challenge_id, tenantId, accountSession.userId],
    { consistencyClass: 'primary_required' }
  );
  if (existing) {
    if (existing.idempotency_key_sha256 !== idempotencyKeySha256) {
      return c.json({ error: 'conflict', error_description: 'Idempotency key conflict' }, 409);
    }
    return operationResponse(c, {
      operationId: existing.operation_id,
      tenantId,
      accountId: accountSession.userId,
    });
  }
  const challenge = await pii.defaultPiiAdapter.queryOne<ChallengeRow>(
    `SELECT tenant_id, account_id, normalized_value_json, value_sha256, otp_verifier,
            delivery_state, attempt_count, attempt_limit, expires_at, consumed_at,
            initiating_session_ref, recent_reauth_verified_at
       FROM identity_identifier_replacement_challenges
      WHERE challenge_id = ?`,
    [body.challenge_id],
    { consistencyClass: 'primary_required' }
  );
  if (
    !challenge ||
    challenge.tenant_id !== tenantId ||
    challenge.account_id !== accountSession.userId ||
    challenge.initiating_session_ref !== accountSession.sessionId ||
    challenge.delivery_state !== 'sent' ||
    (challenge.consumed_at === null && challenge.expires_at < now) ||
    (challenge.consumed_at !== null &&
      now > challenge.consumed_at + CONSUMED_CHALLENGE_RECOVERY_TTL_SECONDS) ||
    (challenge.consumed_at === null && challenge.attempt_count >= challenge.attempt_limit)
  ) {
    return c.json({ error: 'invalid_code', error_description: 'Code is invalid or expired' }, 400);
  }
  const suppliedVerifier = await hmac(`${body.challenge_id}\0${body.code}`, otpSecret(c.env));
  const verifierMatches = constantTimeHexEqual(suppliedVerifier, challenge.otp_verifier);
  if (challenge.consumed_at === null) {
    const consumed = await pii.defaultPiiAdapter.execute(
      `UPDATE identity_identifier_replacement_challenges
          SET attempt_count = attempt_count + 1,
              consumed_at = CASE WHEN otp_verifier = ? THEN ? ELSE consumed_at END,
              updated_at = ?
        WHERE challenge_id = ? AND delivery_state = 'sent' AND consumed_at IS NULL
          AND expires_at >= ? AND attempt_count < attempt_limit`,
      [suppliedVerifier, now, now, body.challenge_id, now]
    );
    if (consumed.rowsAffected !== 1 || !verifierMatches) {
      return c.json(
        { error: 'invalid_code', error_description: 'Code is invalid or expired' },
        400
      );
    }
  } else if (!verifierMatches || challenge.consumed_at > challenge.expires_at) {
    return c.json({ error: 'invalid_code', error_description: 'Code is invalid or expired' }, 400);
  }
  const newEmail = JSON.parse(challenge.normalized_value_json) as unknown;
  if (typeof newEmail !== 'string') {
    return c.json({ error: 'server_error', error_description: 'Challenge is invalid' }, 500);
  }
  const { pii: runtimePii, user } = await runtimeUser(c, tenantId, accountSession.userId);
  if (!user?.email) {
    return c.json({ error: 'not_found', error_description: 'Account email was not found' }, 404);
  }
  const oldEmail = normalizeLookupEmail(user.email);
  if (oldEmail === newEmail) {
    return c.json({ error: 'invalid_request', error_description: 'Email is unchanged' }, 400);
  }
  const keys = (await loadLookupHmacRuntimeKeys(c.env)).readKeys;
  const [oldIndexes, newIndexes] = await Promise.all([
    createLookupBlindIndexes('email_exact', oldEmail, keys),
    createLookupBlindIndexes('email_exact', newEmail, keys),
  ]);
  const operationId = `identifier-replacement:${body.challenge_id.slice('identifier-replacement-'.length)}`;
  const outboxId = `identifier-replacement-outbox:${body.challenge_id.slice('identifier-replacement-'.length)}`;
  const oldValueSha256 = await sha256(oldEmail);
  const requestFingerprintSha256 = await sha256(
    JSON.stringify({
      tenantId,
      accountId: accountSession.userId,
      oldValueSha256,
      newValueSha256: challenge.value_sha256,
    })
  );
  const repository = new IdentifierReplacementOperationRepository(runtimePii.defaultPiiAdapter);
  try {
    await repository.create({
      operationId,
      outboxId,
      tenantId,
      accountId: accountSession.userId,
      authority: 'self_service',
      actorRef: accountSession.userId,
      idempotencyKeySha256,
      requestFingerprintSha256,
      challengeId: body.challenge_id,
      initiatingSessionRef: accountSession.sessionId,
      oldValue: oldEmail,
      newValue: newEmail,
      oldValueSha256,
      newValueSha256: challenge.value_sha256,
      oldIndexes,
      newIndexes,
      authorityEvidence: {
        authority: 'account_session',
        recentReauthVerifiedAt: challenge.recent_reauth_verified_at,
      },
      verificationEvidence: { method: 'email_otp', verifiedAt: now },
    });
  } catch (error) {
    const active = await runtimePii.defaultPiiAdapter.queryOne<{ operation_id: string }>(
      `SELECT operation_id
         FROM identity_identifier_replacement_operations
        WHERE tenant_id = ? AND account_id = ? AND identifier_kind = 'email_exact'
          AND state NOT IN ('completed', 'canceled')`,
      [tenantId, accountSession.userId],
      { consistencyClass: 'primary_required' }
    );
    if (active) {
      return c.json(
        { error: 'conflict', error_description: 'An email change is already active' },
        409
      );
    }
    throw error;
  }
  return operationResponse(c, { operationId, tenantId, accountId: accountSession.userId });
}

export async function getAccountIdentifierReplacementHandler(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  noStore(c);
  const accountSession = await requireAccountSession(c);
  if (accountSession instanceof Response) return accountSession;
  const operationId = c.req.param('id');
  if (!operationId || !/^identifier-replacement:[a-f0-9-]{36}$/u.test(operationId)) {
    return c.json({ error: 'not_found', error_description: 'Operation was not found' }, 404);
  }
  const tenantId = getTenantIdFromContext(c);
  const pii = createPIIContextFromHono(c, tenantId);
  const operationScope = await pii.defaultPiiAdapter.queryOne<{
    operation_id: string;
    state: string;
  }>(
    `SELECT operation_id, state
       FROM identity_identifier_replacement_operations
      WHERE operation_id = ? AND tenant_id = ? AND account_id = ? AND authority = 'self_service'`,
    [operationId, tenantId, accountSession.userId],
    { consistencyClass: 'primary_required' }
  );
  if (!operationScope) {
    return c.json({ error: 'not_found', error_description: 'Operation was not found' }, 404);
  }
  if (!['completed', 'canceled', 'blocked_forward_repair'].includes(operationScope.state)) {
    await resumeIdentifierReplacementOperation(c, {
      operationId,
      tenantId,
      accountId: accountSession.userId,
    });
  }
  const row = await pii.defaultPiiAdapter.queryOne<{
    operation_id: string;
    state: string;
    error_code: string | null;
    created_at: number;
    updated_at: number;
    completed_at: number | null;
  }>(
    `SELECT operation_id, state, error_code, created_at, updated_at, completed_at
       FROM identity_identifier_replacement_operations
      WHERE operation_id = ? AND tenant_id = ? AND account_id = ? AND authority = 'self_service'`,
    [operationId, tenantId, accountSession.userId],
    { consistencyClass: 'primary_required' }
  );
  if (!row)
    return c.json({ error: 'not_found', error_description: 'Operation was not found' }, 404);
  return c.json({
    operation: {
      id: row.operation_id,
      state: row.state,
      error_code:
        row.state === 'blocked_forward_repair' ? 'identifier_replacement_forward_repair' : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at,
    },
  });
}
