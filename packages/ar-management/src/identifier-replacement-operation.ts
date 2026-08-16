import type { DatabaseAdapter } from '@authrim/ar-lib-core';
import type { LookupBlindIndex } from '@authrim/ar-lib-core';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const HEX_64 = /^[a-f0-9]{64}$/u;
const RETRY_BUDGET_SECONDS = 2 * 60 * 60;

export type IdentifierReplacementAuthority = 'self_service' | 'admin' | 'scim' | 'external_idp';
export type ReplaceableIdentifierKind = 'email_exact' | 'external_subject';

export interface IdentifierReplacementOperationView {
  operationId: string;
  state:
    | 'directory_pending'
    | 'authoritative_switch_pending'
    | 'authoritative_switched'
    | 'revocation_pending'
    | 'completed'
    | 'blocked_forward_repair'
    | 'canceled';
  createdAt: number;
  updatedAt: number;
  errorCode: string | null;
}

export interface CreateIdentifierReplacementOperationInput {
  operationId: string;
  outboxId: string;
  tenantId: string;
  accountId: string;
  authority: IdentifierReplacementAuthority;
  identifierKind?: ReplaceableIdentifierKind;
  actorRef: string;
  idempotencyKeySha256: string;
  requestFingerprintSha256: string;
  challengeId?: string;
  initiatingSessionRef?: string;
  oldValue: string;
  newValue: string;
  oldValueSha256: string;
  newValueSha256: string;
  oldIndexes: LookupBlindIndex[];
  newIndexes: LookupBlindIndex[];
  authorityEvidence: Record<string, unknown>;
  verificationEvidence: Record<string, unknown>;
}

interface OperationRow {
  operation_id: string;
  state: IdentifierReplacementOperationView['state'];
  request_fingerprint_sha256: string;
  created_at: number;
  updated_at: number;
  error_code: string | null;
}

function exactIndexes(
  indexes: LookupBlindIndex[],
  field: 'oldIndexes' | 'newIndexes',
  identifierKind: ReplaceableIdentifierKind
): LookupBlindIndex[] {
  if (indexes.length < 1 || indexes.length > 2) {
    throw new Error(`identifier_replacement_${field}_invalid`);
  }
  const generations = new Set<number>();
  return indexes.map((index) => {
    if (
      index.indexKind !== identifierKind ||
      !Number.isSafeInteger(index.normalizationVersion) ||
      index.normalizationVersion < 1 ||
      !Number.isSafeInteger(index.hmacKeyGeneration) ||
      index.hmacKeyGeneration < 1 ||
      !Number.isSafeInteger(index.virtualBucket) ||
      index.virtualBucket < 0 ||
      index.virtualBucket > 4095 ||
      !HEX_64.test(index.digest) ||
      generations.has(index.hmacKeyGeneration)
    ) {
      throw new Error(`identifier_replacement_${field}_invalid`);
    }
    generations.add(index.hmacKeyGeneration);
    return { ...index };
  });
}

function validateInput(input: CreateIdentifierReplacementOperationInput): {
  identifierKind: ReplaceableIdentifierKind;
  oldIndexes: LookupBlindIndex[];
  newIndexes: LookupBlindIndex[];
} {
  const identifierKind = input.identifierKind ?? 'email_exact';
  for (const value of [
    input.operationId,
    input.outboxId,
    input.tenantId,
    input.accountId,
    input.actorRef,
  ]) {
    if (!SAFE_ID.test(value)) throw new Error('identifier_replacement_input_invalid');
  }
  if (
    !HEX_64.test(input.idempotencyKeySha256) ||
    !HEX_64.test(input.requestFingerprintSha256) ||
    !HEX_64.test(input.oldValueSha256) ||
    !HEX_64.test(input.newValueSha256) ||
    input.oldValueSha256 === input.newValueSha256 ||
    input.oldValue === input.newValue ||
    input.oldValue.length < 3 ||
    input.newValue.length < 3 ||
    (input.authority === 'self_service' && identifierKind !== 'email_exact') ||
    (input.authority === 'self_service' &&
      (!input.challengeId ||
        !SAFE_ID.test(input.challengeId) ||
        !input.initiatingSessionRef ||
        !SAFE_ID.test(input.initiatingSessionRef)))
  ) {
    throw new Error('identifier_replacement_input_invalid');
  }
  const oldIndexes = exactIndexes(input.oldIndexes, 'oldIndexes', identifierKind);
  const newIndexes = exactIndexes(input.newIndexes, 'newIndexes', identifierKind);
  if (
    oldIndexes.length !== newIndexes.length ||
    oldIndexes.some((oldIndex) => {
      const next = newIndexes.find(
        (candidate) => candidate.hmacKeyGeneration === oldIndex.hmacKeyGeneration
      );
      return !next || next.normalizationVersion !== oldIndex.normalizationVersion;
    })
  ) {
    throw new Error('identifier_replacement_generation_mismatch');
  }
  return { identifierKind, oldIndexes, newIndexes };
}

function view(row: OperationRow): IdentifierReplacementOperationView {
  return {
    operationId: row.operation_id,
    state: row.state,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    errorCode: row.error_code,
  };
}

export class IdentifierReplacementOperationRepository {
  constructor(
    private readonly pii: DatabaseAdapter,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000)
  ) {}

  async create(
    input: CreateIdentifierReplacementOperationInput
  ): Promise<IdentifierReplacementOperationView> {
    const { identifierKind, oldIndexes, newIndexes } = validateInput(input);
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 1) {
      throw new Error('identifier_replacement_time_invalid');
    }
    const existing = await this.pii.queryOne<OperationRow>(
      `SELECT operation_id, state, request_fingerprint_sha256, created_at, updated_at, error_code
         FROM identity_identifier_replacement_operations
        WHERE tenant_id = ? AND authority = ? AND idempotency_key_sha256 = ?`,
      [input.tenantId, input.authority, input.idempotencyKeySha256],
      { consistencyClass: 'primary_required' }
    );
    if (existing) {
      if (
        existing.operation_id !== input.operationId ||
        existing.request_fingerprint_sha256 !== input.requestFingerprintSha256
      ) {
        throw new Error('identifier_replacement_idempotency_conflict');
      }
      return view(existing);
    }

    if (input.challengeId) {
      const challenge = await this.pii.queryOne<{
        tenant_id: string;
        account_id: string;
        normalized_value_json: string;
        consumed_at: number | null;
        expires_at: number;
        initiating_session_ref: string;
      }>(
        `SELECT tenant_id, account_id, normalized_value_json, consumed_at, expires_at,
                initiating_session_ref
           FROM identity_identifier_replacement_challenges
          WHERE challenge_id = ?`,
        [input.challengeId],
        { consistencyClass: 'primary_required' }
      );
      if (
        !challenge ||
        challenge.tenant_id !== input.tenantId ||
        challenge.account_id !== input.accountId ||
        challenge.initiating_session_ref !== input.initiatingSessionRef ||
        challenge.consumed_at === null ||
        challenge.expires_at < challenge.consumed_at ||
        challenge.normalized_value_json !== JSON.stringify(input.newValue)
      ) {
        throw new Error('identifier_replacement_challenge_invalid');
      }
    }

    const projections = [
      ...oldIndexes.map((index) => ({ side: 'old' as const, index })),
      ...newIndexes.map((index) => ({ side: 'new' as const, index })),
    ];
    const payload = JSON.stringify({
      operationId: input.operationId,
      tenantId: input.tenantId,
      accountId: input.accountId,
      identifierKind,
      projections: projections.map(({ side, index }) => ({
        side,
        normalizationVersion: index.normalizationVersion,
        hmacKeyGeneration: index.hmacKeyGeneration,
        virtualBucket: index.virtualBucket,
        blindDigest: index.digest,
      })),
    });
    const statements = [
      {
        sql: `INSERT INTO identity_identifier_replacement_operations (
                operation_id, tenant_id, account_id, identifier_kind, authority,
                idempotency_key_sha256, request_fingerprint_sha256, challenge_id,
                initiating_session_ref, outbox_id, retry_budget_expires_at, created_at, updated_at
              ) VALUES (?, ?, ?, '${identifierKind}', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          input.operationId,
          input.tenantId,
          input.accountId,
          input.authority,
          input.idempotencyKeySha256,
          input.requestFingerprintSha256,
          input.challengeId ?? null,
          input.initiatingSessionRef ?? null,
          input.outboxId,
          now + RETRY_BUDGET_SECONDS,
          now,
          now,
        ],
      },
      {
        sql: `INSERT INTO identity_identifier_replacement_history (
                operation_id, old_value_json, new_value_json, old_value_sha256, new_value_sha256,
                normalization_version, actor_ref, authority_evidence_json,
                verification_evidence_json, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          input.operationId,
          JSON.stringify(input.oldValue),
          JSON.stringify(input.newValue),
          input.oldValueSha256,
          input.newValueSha256,
          oldIndexes[0].normalizationVersion,
          input.actorRef,
          JSON.stringify(input.authorityEvidence),
          JSON.stringify(input.verificationEvidence),
          now,
        ],
      },
      ...projections.map(({ side, index }) => ({
        sql: `INSERT INTO identity_identifier_replacement_projections (
                operation_id, identifier_side, hmac_key_generation, normalization_version,
                virtual_bucket, blind_digest, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          input.operationId,
          side,
          index.hmacKeyGeneration,
          index.normalizationVersion,
          index.virtualBucket,
          index.digest,
          now,
          now,
        ],
      })),
      {
        sql: `INSERT INTO identity_identifier_replacement_outbox (
                outbox_id, operation_id, tenant_id, account_id, event_kind,
                payload_json, created_at, updated_at
              ) VALUES (?, ?, ?, ?, 'identifier_replacement', ?, ?, ?)`,
        params: [
          input.outboxId,
          input.operationId,
          input.tenantId,
          input.accountId,
          payload,
          now,
          now,
        ],
      },
    ];
    try {
      await this.pii.batch(statements);
    } catch (error) {
      const adopted = await this.pii.queryOne<OperationRow>(
        `SELECT operation_id, state, request_fingerprint_sha256, created_at, updated_at, error_code
           FROM identity_identifier_replacement_operations
          WHERE tenant_id = ? AND authority = ? AND idempotency_key_sha256 = ?`,
        [input.tenantId, input.authority, input.idempotencyKeySha256],
        { consistencyClass: 'primary_required' }
      );
      if (
        !adopted ||
        adopted.operation_id !== input.operationId ||
        adopted.request_fingerprint_sha256 !== input.requestFingerprintSha256
      ) {
        const active = await this.pii.queryOne<{ operation_id: string }>(
          `SELECT operation_id
             FROM identity_identifier_replacement_operations
            WHERE tenant_id = ? AND account_id = ? AND identifier_kind = ?
              AND state NOT IN ('completed', 'canceled')`,
          [input.tenantId, input.accountId, identifierKind],
          { consistencyClass: 'primary_required' }
        );
        if (active) throw new Error('identifier_replacement_operation_active');
        throw error;
      }
      return view(adopted);
    }
    return {
      operationId: input.operationId,
      state: 'directory_pending',
      createdAt: now,
      updatedAt: now,
      errorCode: null,
    };
  }
}
