/**
 * Records of failed sign-in attempts, for investigating a sign-in problem without personal data.
 *
 * A failure is recorded in the `core.flow_audit_events` log dataset, tied to the Flow interaction the attempt
 * belongs to. Attempts outside any Flow interaction are not recorded. The record carries no user
 * ID: once the account is known, it carries the account's subject hash instead (an HMAC under the
 * environment's investigation keyring), so an investigator who already knows the account can
 * find its attempts, and nobody can read the account off a record. Each record has a deterministic 128-bit
 * inquiry number, scoped to its tenant and opaque event ID, that a person can quote.
 *
 * INVESTIGATION_SUBJECT_HMAC_KEYRING has the tombstone keyring's shape and rotation: new hashes
 * are made with the current generation, every listed generation is read, and a generation is
 * removed only once every record made with it is past retention.
 */

import type { DatabaseAdapter } from '../db';
import type { LookupBlindIndexKey } from './lookup-directory/blind-index';
import { parseGenerationalHmacKeyring, type TombstoneHmacKeys } from './tombstone-hmac-keyring';
import { emitLogIcebergRow, buildLogIcebergRowRecord } from './log-iceberg-emitter';
import { createLogIcebergWritePort } from './log-iceberg-runtime';
import { resolveLogIcebergConfig } from './log-iceberg-config';
import { signInAttemptLogLogicalHmac } from './log-iceberg-sign-in-attempt';
import type { LogIcebergRuntimeEnv } from './log-iceberg-runtime';
import { runTenantBackupCoveredEffect } from './tenant-portability/covered-mutation';

/** The sign-in methods whose failures are recorded. */
export const SIGN_IN_ATTEMPT_METHODS = [
  'passkey',
  'totp',
  'email_code',
  'directory_password',
  'external_idp',
  'saml',
] as const;
export type SignInAttemptMethod = (typeof SIGN_IN_ATTEMPT_METHODS)[number];

/**
 * Why an attempt failed, as a closed vocabulary: no error text is ever recorded. The status read
 * returns only these values, and its OpenAPI enum is this list.
 */
export const SIGN_IN_ATTEMPT_REASON_CODES = [
  'challenge_expired',
  'challenge_mismatch',
  'method_disabled',
  'credential_not_found',
  'verification_failed',
  'invalid_code',
  'replay_detected',
  'rate_limited',
  'account_mismatch',
  'account_unavailable',
  'guest_denied',
  'service_unavailable',
  'account_not_linked',
  'migration_blocked',
  'upstream_error',
  'email_not_verified',
  'signup_disabled',
  'assurance_not_met',
  'policy_denied',
  'provisioning_failed',
] as const;
export type SignInAttemptReasonCode = (typeof SIGN_IN_ATTEMPT_REASON_CODES)[number];

export const SIGN_IN_ATTEMPT_FAILED_EVENT = 'flow.sign_in_attempt.failed';

/** The header a Login UI names the Flow interaction of an attempt with, at its start step. */
export const SIGN_IN_ATTEMPT_INTERACTION_HEADER = 'X-Authrim-Interaction-Id';

/** Challenge metadata key holding the interaction a start step validated. */
export const SIGN_IN_ATTEMPT_INTERACTION_METADATA_KEY = 'attempt_interaction_id';

export type InvestigationSubjectHmacKeys = TombstoneHmacKeys;

const SUBJECT_HASH_LABEL = 'isub';
const SUBJECT_HASH_VERSION = 1;
const SUBJECT_HASH = /^isub:v1:g([1-9][0-9]{0,8}):[0-9a-f]{64}$/u;
const INTERACTION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const INQUIRY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const encoder = new TextEncoder();

/**
 * The environment's investigation keys; null when the secret is not set (subject hashes are then
 * neither written nor read). Throws `investigation_subject_hmac_keyring_invalid` when malformed.
 */
export function loadInvestigationSubjectHmacKeysFromEnv(env: {
  INVESTIGATION_SUBJECT_HMAC_KEYRING?: string;
}): InvestigationSubjectHmacKeys | null {
  const value = env.INVESTIGATION_SUBJECT_HMAC_KEYRING;
  if (typeof value !== 'string' || value.trim() === '') return null;
  return parseGenerationalHmacKeyring(value, 'investigation_subject_hmac_keyring_invalid');
}

function lengthPrefixed(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  const result = new Uint8Array(4 + bytes.length);
  new DataView(result.buffer).setUint32(0, bytes.length, false);
  result.set(bytes, 4);
  return result;
}

/** The subject hash of a tenant's account under one key: `isub:v1:g<generation>:<hex>`. */
export async function computeInvestigationSubjectHash(
  key: LookupBlindIndexKey,
  tenantId: string,
  userId: string
): Promise<string> {
  if (!Number.isSafeInteger(key.generation) || key.generation < 1) {
    throw new Error('investigation_subject_hmac_key_invalid');
  }
  const parts = [
    encoder.encode(SUBJECT_HASH_LABEL),
    new Uint8Array([0, SUBJECT_HASH_VERSION]),
    lengthPrefixed(tenantId),
    lengthPrefixed(userId),
  ];
  const message = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    message.set(part, offset);
    offset += part.length;
  }
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key.secret === 'string' ? encoder.encode(key.secret) : key.secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, message)),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('');
  return `${SUBJECT_HASH_LABEL}:v${SUBJECT_HASH_VERSION}:g${key.generation}:${digest}`;
}

/** Every hash the account's records may carry: one per key the keyring can read. */
export async function investigationSubjectHashes(
  keys: InvestigationSubjectHmacKeys,
  tenantId: string,
  userId: string
): Promise<string[]> {
  return Promise.all(
    keys.readKeys.map((key) => computeInvestigationSubjectHash(key, tenantId, userId))
  );
}

export function isInvestigationSubjectHash(value: unknown): value is string {
  return typeof value === 'string' && SUBJECT_HASH.test(value);
}

/** A tenant-scoped deterministic 128-bit inquiry number, encoded as 26 Crockford characters. */
export async function generateInquiryNumber(tenantId: string, eventId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(JSON.stringify(['authrim.sign-in-inquiry', 1, tenantId, eventId]))
    )
  ).subarray(0, 16);
  let bits = 0,
    value = 0,
    result = '';
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += INQUIRY_ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits) result += INQUIRY_ALPHABET[(value << (5 - bits)) & 31];
  return result;
}

/**
 * The interaction a start step was told about, when it is a live Flow interaction of the tenant
 * (and of the same client, when the step knows its client). Otherwise null: the attempt is then
 * not recorded. Only a value this returns may be stored with a challenge, so a verify step can
 * never be pointed at another interaction.
 */
export async function resolveSignInAttemptInteraction(
  core: DatabaseAdapter,
  input: {
    tenantId: string;
    interactionId: string | null | undefined;
    clientId?: string | null;
    nowSeconds?: number;
  }
): Promise<string | null> {
  const interactionId = input.interactionId?.trim();
  if (!interactionId || !INTERACTION_ID.test(interactionId)) return null;
  const interaction = await core.queryOne<{ client_id: string | null }>(
    `SELECT client_id FROM flow_interactions
      WHERE tenant_id = ? AND id = ? AND state IN ('created', 'active') AND expires_at > ?`,
    [input.tenantId, interactionId, input.nowSeconds ?? Math.floor(Date.now() / 1000)]
  );
  if (!interaction) return null;
  if (input.clientId && interaction.client_id && interaction.client_id !== input.clientId) {
    return null;
  }
  return interactionId;
}

/** The validated interaction a challenge's metadata holds, or null. */
export function signInAttemptInteractionFromMetadata(
  metadata: Record<string, unknown> | null | undefined
): string | null {
  const value = metadata?.[SIGN_IN_ATTEMPT_INTERACTION_METADATA_KEY];
  return typeof value === 'string' && INTERACTION_ID.test(value) ? value : null;
}

export interface SignInAttemptFailure {
  tenantId: string;
  /** The interaction a start step validated (resolveSignInAttemptInteraction). */
  interactionId: string;
  method: SignInAttemptMethod;
  reasonCode: SignInAttemptReasonCode;
  /** The account, once the attempt knows it; recorded only as its subject hash. */
  userId?: string | null;
  /** An opaque ID from consumed server state; only its domain-separated digest is stored. */
  dedupeKey?: string;
}

async function signInAttemptEventId(input: SignInAttemptFailure): Promise<string | null> {
  if (input.dedupeKey === undefined) return null;
  // JSON's array encoding separates fields unambiguously. No raw state/token/account is stored.
  const encoded = JSON.stringify([
    'authrim.sign-in-attempt.failed.id',
    1,
    input.tenantId,
    input.interactionId,
    input.method,
    input.dedupeKey,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(encoded));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
  return `sia:v1:${hex}`;
}

/**
 * Records a failed attempt in its interaction's encrypted log dataset. Returns the record's inquiry
 * number, or null when the interaction is gone. The subject hash is left out when no keyring is
 * configured. Callers run this after the response and never let it fail a sign-in.
 */
export async function recordSignInAttemptFailure(
  env: LogIcebergRuntimeEnv,
  core: DatabaseAdapter,
  keys: InvestigationSubjectHmacKeys | null,
  input: SignInAttemptFailure,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<string | null> {
  if (
    !SIGN_IN_ATTEMPT_METHODS.includes(input.method) ||
    !SIGN_IN_ATTEMPT_REASON_CODES.includes(input.reasonCode) ||
    !INTERACTION_ID.test(input.interactionId) ||
    (input.dedupeKey !== undefined &&
      (typeof input.dedupeKey !== 'string' ||
        input.dedupeKey.length === 0 ||
        input.dedupeKey.length > 256))
  ) {
    throw new Error('sign_in_attempt_failure_invalid');
  }
  const interaction = await core.queryOne<{
    flow_id: string;
    flow_version_id: string;
    client_id: string | null;
    saml_sp_id: string | null;
    current_node_id: string | null;
    contract_hash: string;
  }>(
    `SELECT flow_id, flow_version_id, client_id, saml_sp_id, current_node_id, contract_hash
       FROM flow_interactions
      WHERE tenant_id = ? AND id = ?`,
    [input.tenantId, input.interactionId]
  );
  if (!interaction) return null;
  const subjectHash =
    keys && input.userId
      ? await computeInvestigationSubjectHash(keys.writeKey, input.tenantId, input.userId)
      : null;
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0)
    throw new Error('sign_in_attempt_failure_invalid');
  const eventId = (await signInAttemptEventId(input)) ?? crypto.randomUUID();
  const inquiryNumber = await generateInquiryNumber(input.tenantId, eventId);
  const write = (failedAt: number) => ({
    tenantId: input.tenantId,
    sourceDataset: 'core.flow_audit_events',
    logType: 'normal',
    eventAt: failedAt * 1000,
    expiresAt: null,
    overview: {
      action: SIGN_IN_ATTEMPT_FAILED_EVENT,
      result: 'failure',
      reason_code: input.reasonCode,
      client_id: interaction.client_id,
    },
    row: {
      id: eventId,
      tenant_id: input.tenantId,
      interaction_id: input.interactionId,
      flow_id: interaction.flow_id,
      flow_version_id: interaction.flow_version_id,
      user_id: null,
      client_id: interaction.client_id,
      saml_sp_id: interaction.saml_sp_id,
      node_id: interaction.current_node_id,
      branch_handle_id: null,
      event_type: SIGN_IN_ATTEMPT_FAILED_EVENT,
      result: 'failure',
      error_code: null,
      contract_hash: interaction.contract_hash,
      metadata_json: null,
      method: input.method,
      reason_code: input.reasonCode,
      subject_hash: subjectHash,
      inquiry_number: inquiryNumber,
      created_at: failedAt,
    },
  });
  if (input.dedupeKey === undefined) {
    await emitLogIcebergRow(env, write(nowSeconds));
    return inquiryNumber;
  }
  const writer =
    env.LOG_ARCHIVE_WRITER ?? createLogIcebergWritePort(env, resolveLogIcebergConfig(env));
  const persist = async () => {
    const logicalHmac = await signInAttemptLogLogicalHmac(env, {
      tenantId: input.tenantId,
      eventId,
      row: write(nowSeconds).row,
    });
    const reservation = await writer.reserveSignInAttempt({
      tenantId: input.tenantId,
      eventId,
      failedAt: nowSeconds,
      logicalHmac,
    });
    const record = await buildLogIcebergRowRecord(env, write(reservation.failedAt));
    await writer.commitSignInAttempt({ tenantId: input.tenantId, eventId, record });
    return inquiryNumber;
  };
  return env.LOG_ARCHIVE_WRITER
    ? persist()
    : runTenantBackupCoveredEffect(
        { CONTROL: env.CONTROL, TENANT_BACKUP_WRAPPING_KEY: 'required' },
        { tenantId: input.tenantId },
        persist
      );
}

/**
 * Records a failed attempt after the response, for Workers outside a Hono request helper: the
 * recording waits on `waitUntil`, never the response, and a failure to record is only reported
 * (by `onError`, which must log no more than the error's type).
 */
export function scheduleSignInAttemptFailureRecord(
  options: {
    waitUntil?: ((promise: Promise<unknown>) => void) | null;
    core: () => Promise<DatabaseAdapter> | DatabaseAdapter;
    env: LogIcebergRuntimeEnv & { INVESTIGATION_SUBJECT_HMAC_KEYRING?: string };
    onError?: (error: unknown) => void;
  },
  input: Omit<SignInAttemptFailure, 'interactionId'> & { interactionId: string | null | undefined }
): void {
  const interactionId = input.interactionId;
  if (!interactionId || !INTERACTION_ID.test(interactionId)) return;
  const recording = (async () => {
    let keys: InvestigationSubjectHmacKeys | null = null;
    try {
      keys = loadInvestigationSubjectHmacKeysFromEnv(options.env);
    } catch (error) {
      // A malformed keyring: the attempt is still recorded, without the subject hash.
      options.onError?.(error);
    }
    await recordSignInAttemptFailure(options.env, await options.core(), keys, {
      ...input,
      interactionId,
      userId: input.userId && input.userId !== 'unknown' ? input.userId : null,
    });
  })().catch((error: unknown) => options.onError?.(error));
  try {
    if (options.waitUntil) options.waitUntil(recording);
  } catch {
    // No execution context: the recording runs on its own.
  }
}
