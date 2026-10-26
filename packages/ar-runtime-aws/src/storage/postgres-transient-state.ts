/**
 * PostgreSQL-backed, tenant-scoped transient state for the AWS SAML IdP runtime.
 *
 * The methods expose protocol state, not a D1/DO emulator. Every one-use read is a
 * single conditional UPDATE ... RETURNING statement, so concurrent Lambda invocations
 * cannot both consume the same request or challenge. PostgreSQL's clock is the
 * authority for expiry decisions.
 */

import type { SAMLRequestData } from '@authrim/ar-lib-core';

export interface PostgresQueryClient {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values: unknown[]
  ): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface TransientSession {
  tenantId: string;
  sessionId: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
  revocationBoundAtMs: number;
  data?: Record<string, unknown>;
}

export interface StoreSessionInput {
  tenantId: string;
  sessionId: string;
  userId: string;
  ttlMs: number;
  data?: Record<string, unknown>;
}

export interface StoreChallengeInput {
  tenantId: string;
  id: string;
  type: string;
  userId: string;
  challenge: string;
  ttlMs: number;
  /** Absolute upper bound in milliseconds, for a parent interaction's deadline. */
  notAfterMs?: number;
  email?: string;
  redirectUri?: string;
  metadata?: Record<string, unknown>;
}

export interface ConsumeChallengeInput {
  tenantId: string;
  id: string;
  type: string;
  /** Omit only when `id` itself is a high-entropy bearer secret. */
  challenge?: string;
}

export interface TransientChallenge {
  id: string;
  tenantId: string;
  type: string;
  userId: string;
  challenge: string;
  createdAt: number;
  expiresAt: number;
  email?: string;
  redirectUri?: string;
  metadata?: Record<string, unknown>;
}

export interface StoreSamlRequestInput {
  tenantId: string;
  spEntityId: string;
  request: SAMLRequestData;
}

export interface ConsumeSamlRequestInput {
  tenantId: string;
  spEntityId: string;
  requestId: string;
}

export interface PutTransientKeyInput {
  tenantId: string;
  key: string;
  value: string;
  ttlMs: number;
}

type StoredRow = {
  payload: unknown;
  created_at_ms: string | number;
  expires_at_ms: string | number;
  consumed_at_ms?: string | number | null;
  revocation_bound_at_ms?: string | number | null;
};

const TABLE = 'authrim_aws_transient_state';
const DB_NOW_MS = 'floor(extract(epoch from clock_timestamp()) * 1000)::bigint';
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SAML_REQUEST_FUTURE_MS = 30 * 60 * 1000;
const MAX_JSON_BYTES = 64 * 1024;
const TENANT_ID_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function assertTenantId(value: string): void {
  if (!TENANT_ID_PATTERN.test(value)) throw new Error('Invalid tenant ID');
}

function assertIdentifier(value: string, name: string, maxLength = 1024): void {
  if (!value || value.length > maxLength) {
    throw new Error(`Invalid ${name}`);
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) throw new Error(`Invalid ${name}`);
  }
}

function assertTtlMs(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TTL_MS) {
    throw new Error('Invalid transient state TTL');
  }
}

function assertTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
}

function jsonObject(value: Record<string, unknown>): string {
  const encoded = JSON.stringify(value);
  if (!encoded || new TextEncoder().encode(encoded).byteLength > MAX_JSON_BYTES) {
    throw new Error('Transient state payload is too large');
  }
  return encoded;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid transient state payload');
  }
  return value as Record<string, unknown>;
}

function asMs(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('Invalid transient state timestamp');
  }
  return parsed;
}

/**
 * Fields that identify the original signed AuthnRequest and its browser relay.
 * Context and store timestamps may change as the trusted IdP handler resumes.
 * JSONB equality in PostgreSQL ignores object property order.
 */
function samlImmutablePart(request: SAMLRequestData): Record<string, unknown> {
  return {
    requestId: request.requestId,
    issuer: request.issuer,
    destination: request.destination,
    acsUrl: request.acsUrl ?? null,
    binding: request.binding,
    type: request.type,
    relayState: request.relayState ?? null,
    data: request.data ?? null,
  };
}

function readSamlRequest(row: StoredRow, expected: ConsumeSamlRequestInput): SAMLRequestData {
  const payload = asObject(row.payload);
  const request = asObject(payload.request);
  if (
    payload.spEntityId !== expected.spEntityId ||
    request.requestId !== expected.requestId ||
    request.issuer !== expected.spEntityId ||
    request.type !== 'authn_request'
  ) {
    throw new Error('SAML request storage binding invalid');
  }
  return {
    ...(request as unknown as SAMLRequestData),
    createdAt: asMs(row.created_at_ms),
    expiresAt: asMs(row.expires_at_ms),
    used: true,
  };
}

/** The bootstrap DDL for this table is in schema.sql; release migrations are separate. */
export class PostgresTransientStateStore {
  constructor(private readonly db: PostgresQueryClient) {}

  async createSession(input: StoreSessionInput): Promise<TransientSession> {
    assertTenantId(input.tenantId);
    assertIdentifier(input.sessionId, 'session ID');
    assertIdentifier(input.userId, 'user ID');
    assertTtlMs(input.ttlMs);
    const payload = jsonObject({
      userId: input.userId,
      ...(input.data ? { data: input.data } : {}),
    });
    const result = await this.db.query<StoredRow>(
      `/* aws-transient:create-session */
       WITH at AS (SELECT ${DB_NOW_MS} AS now_ms)
       INSERT INTO ${TABLE} (tenant_id, kind, id, payload, immutable_payload,
                             created_at_ms, expires_at_ms, consumed_at_ms,
                             revocation_bound_at_ms)
       SELECT $1, 'session', $2, $4::jsonb, '{}'::jsonb,
              at.now_ms, at.now_ms + $5::bigint, NULL,
              GREATEST(at.now_ms, COALESCE(account.revoked_after_ms, 0) + 1)
       FROM at
       JOIN authrim_aws_account_auth_state AS account
         ON account.tenant_id = $1 AND account.user_id = $3
        AND account.account_id = 'account:' || $3
        AND account.lifecycle = 'active'
       WHERE true
       ON CONFLICT (tenant_id, kind, id) DO NOTHING
       RETURNING payload, created_at_ms, expires_at_ms, revocation_bound_at_ms`,
      [input.tenantId, input.sessionId, input.userId, payload, input.ttlMs]
    );
    const row = result.rows[0];
    if (!row) throw new Error('Session unavailable or ID already exists');
    return this.readSession(row, input.tenantId, input.sessionId);
  }

  async getSession(input: {
    tenantId: string;
    sessionId: string;
  }): Promise<TransientSession | null> {
    assertTenantId(input.tenantId);
    assertIdentifier(input.sessionId, 'session ID');
    const result = await this.db.query<StoredRow>(
      `/* aws-transient:get-session */
       SELECT state.payload, state.created_at_ms, state.expires_at_ms,
              state.revocation_bound_at_ms
       FROM ${TABLE} AS state
       JOIN authrim_aws_account_auth_state AS account
         ON account.tenant_id = state.tenant_id
        AND account.user_id = state.payload->>'userId'
        AND account.account_id = 'account:' || (state.payload->>'userId')
        AND account.lifecycle = 'active'
        AND (account.revoked_after_ms IS NULL
             OR state.revocation_bound_at_ms > account.revoked_after_ms)
       WHERE state.tenant_id = $1 AND state.kind = 'session' AND state.id = $2
         AND state.consumed_at_ms IS NULL AND state.expires_at_ms > ${DB_NOW_MS}`,
      [input.tenantId, input.sessionId]
    );
    return result.rows[0]
      ? this.readSession(result.rows[0], input.tenantId, input.sessionId)
      : null;
  }

  async deleteSession(input: { tenantId: string; sessionId: string }): Promise<boolean> {
    assertTenantId(input.tenantId);
    assertIdentifier(input.sessionId, 'session ID');
    const result = await this.db.query<{ id: string }>(
      `/* aws-transient:delete-session */
       UPDATE ${TABLE} SET consumed_at_ms = ${DB_NOW_MS}
       WHERE tenant_id = $1 AND kind = 'session' AND id = $2
         AND consumed_at_ms IS NULL
       RETURNING id`,
      [input.tenantId, input.sessionId]
    );
    return result.rows.length === 1;
  }

  private readSession(row: StoredRow, tenantId: string, sessionId: string): TransientSession {
    const payload = asObject(row.payload);
    if (typeof payload.userId !== 'string' || !payload.userId) {
      throw new Error('Session storage binding invalid');
    }
    const data = payload.data === undefined ? undefined : asObject(payload.data);
    return {
      tenantId,
      sessionId,
      userId: payload.userId,
      createdAt: asMs(row.created_at_ms),
      expiresAt: asMs(row.expires_at_ms),
      revocationBoundAtMs: asMs(row.revocation_bound_at_ms ?? 0),
      ...(data ? { data } : {}),
    };
  }

  async storeChallenge(input: StoreChallengeInput): Promise<boolean> {
    assertTenantId(input.tenantId);
    assertIdentifier(input.id, 'challenge ID');
    assertIdentifier(input.type, 'challenge type', 128);
    assertIdentifier(input.userId, 'user ID');
    assertIdentifier(input.challenge, 'challenge value', 4096);
    assertTtlMs(input.ttlMs);
    if (input.notAfterMs !== undefined) assertTimestamp(input.notAfterMs, 'challenge deadline');
    const payload = jsonObject({
      type: input.type,
      userId: input.userId,
      challenge: input.challenge,
      ...(input.email ? { email: input.email } : {}),
      ...(input.redirectUri ? { redirectUri: input.redirectUri } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    const result = await this.db.query<{ id: string }>(
      `/* aws-transient:store-challenge */
       WITH at AS (SELECT ${DB_NOW_MS} AS now_ms)
       INSERT INTO ${TABLE} AS current
         (tenant_id, kind, id, payload, immutable_payload, created_at_ms,
          expires_at_ms, consumed_at_ms)
       SELECT $1, 'challenge', $2, $3::jsonb, '{}'::jsonb,
              at.now_ms, LEAST(at.now_ms + $4::bigint, COALESCE($5::bigint, at.now_ms + $4::bigint)),
              NULL FROM at
       WHERE LEAST(at.now_ms + $4::bigint, COALESCE($5::bigint, at.now_ms + $4::bigint)) > at.now_ms
       ON CONFLICT (tenant_id, kind, id) DO UPDATE
         SET payload = EXCLUDED.payload,
             created_at_ms = EXCLUDED.created_at_ms,
             expires_at_ms = EXCLUDED.expires_at_ms,
             consumed_at_ms = NULL
       WHERE current.consumed_at_ms IS NOT NULL
          OR current.expires_at_ms <= ${DB_NOW_MS}
       RETURNING id`,
      [input.tenantId, input.id, payload, input.ttlMs, input.notAfterMs ?? null]
    );
    return result.rows.length === 1;
  }

  /** An absent, consumed, or expired challenge ID is claimed atomically. */
  async claimChallenge(input: StoreChallengeInput): Promise<boolean> {
    return this.storeChallenge(input);
  }

  async consumeChallenge(input: ConsumeChallengeInput): Promise<TransientChallenge | null> {
    assertTenantId(input.tenantId);
    assertIdentifier(input.id, 'challenge ID');
    assertIdentifier(input.type, 'challenge type', 128);
    if (input.challenge !== undefined) {
      assertIdentifier(input.challenge, 'challenge value', 4096);
    }
    const result = await this.db.query<StoredRow>(
      `/* aws-transient:consume-challenge */
       UPDATE ${TABLE} SET consumed_at_ms = ${DB_NOW_MS}
       WHERE tenant_id = $1 AND kind = 'challenge' AND id = $2
         AND payload->>'type' = $3
         AND ($4::text IS NULL OR payload->>'challenge' = $4)
         AND consumed_at_ms IS NULL AND expires_at_ms > ${DB_NOW_MS}
       RETURNING payload, created_at_ms, expires_at_ms`,
      [input.tenantId, input.id, input.type, input.challenge ?? null]
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.readChallenge(row, input.tenantId, input.id, input.type);
  }

  async getChallenge(input: { tenantId: string; id: string }): Promise<TransientChallenge | null> {
    assertTenantId(input.tenantId);
    assertIdentifier(input.id, 'challenge ID');
    const result = await this.db.query<StoredRow>(
      `/* aws-transient:get-challenge */
       SELECT payload, created_at_ms, expires_at_ms FROM ${TABLE}
       WHERE tenant_id = $1 AND kind = 'challenge' AND id = $2
         AND consumed_at_ms IS NULL AND expires_at_ms > ${DB_NOW_MS}`,
      [input.tenantId, input.id]
    );
    if (!result.rows[0]) return null;
    const payload = asObject(result.rows[0].payload);
    if (typeof payload.type !== 'string') throw new Error('Challenge storage binding invalid');
    return this.readChallenge(result.rows[0], input.tenantId, input.id, payload.type);
  }

  /** Check a short lease without consuming it. */
  async isChallengeClaimHeld(input: {
    tenantId: string;
    id: string;
    challenge: string;
    minRemainingMs: number;
  }): Promise<boolean> {
    assertTenantId(input.tenantId);
    assertIdentifier(input.id, 'challenge ID');
    assertIdentifier(input.challenge, 'challenge value', 4096);
    if (!Number.isSafeInteger(input.minRemainingMs) || input.minRemainingMs < 0) {
      throw new Error('Invalid minimum remaining lifetime');
    }
    const result = await this.db.query<{ id: string }>(
      `/* aws-transient:is-challenge-claim-held */
       SELECT id FROM ${TABLE}
       WHERE tenant_id = $1 AND kind = 'challenge' AND id = $2
         AND payload->>'challenge' = $3 AND consumed_at_ms IS NULL
         AND expires_at_ms > ${DB_NOW_MS}
         AND expires_at_ms - ${DB_NOW_MS} >= $4::bigint`,
      [input.tenantId, input.id, input.challenge, input.minRemainingMs]
    );
    return result.rows.length === 1;
  }

  async deleteChallenge(input: { tenantId: string; id: string }): Promise<boolean> {
    assertTenantId(input.tenantId);
    assertIdentifier(input.id, 'challenge ID');
    const result = await this.db.query<{ id: string }>(
      `/* aws-transient:delete-challenge */
       UPDATE ${TABLE} SET consumed_at_ms = ${DB_NOW_MS}
       WHERE tenant_id = $1 AND kind = 'challenge' AND id = $2
         AND consumed_at_ms IS NULL
       RETURNING id`,
      [input.tenantId, input.id]
    );
    return result.rows.length === 1;
  }

  private readChallenge(
    row: StoredRow,
    tenantId: string,
    id: string,
    type: string
  ): TransientChallenge {
    const payload = asObject(row.payload);
    if (
      payload.type !== type ||
      typeof payload.userId !== 'string' ||
      typeof payload.challenge !== 'string'
    ) {
      throw new Error('Challenge storage binding invalid');
    }
    const metadata = payload.metadata === undefined ? undefined : asObject(payload.metadata);
    return {
      tenantId,
      id,
      type,
      userId: payload.userId,
      challenge: payload.challenge,
      createdAt: asMs(row.created_at_ms),
      expiresAt: asMs(row.expires_at_ms),
      ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
      ...(typeof payload.redirectUri === 'string' ? { redirectUri: payload.redirectUri } : {}),
      ...(metadata ? { metadata } : {}),
    };
  }

  /**
   * A trusted IdP continuation may store the same request ID after consuming it.
   * PostgreSQL permits this only for the same SP and immutable AuthnRequest, and
   * retains the original expiry. The operation is serialized by the primary key.
   */
  async storeSamlRequest(input: StoreSamlRequestInput): Promise<void> {
    assertTenantId(input.tenantId);
    assertIdentifier(input.spEntityId, 'SP entity ID', 4096);
    assertIdentifier(input.request.requestId, 'SAML request ID');
    if (input.request.type !== 'authn_request' || input.request.issuer !== input.spEntityId) {
      throw new Error('Invalid SAML request binding');
    }
    assertTimestamp(input.request.expiresAt, 'SAML request expiry');
    const payload = jsonObject({ spEntityId: input.spEntityId, request: input.request });
    const immutable = jsonObject(samlImmutablePart(input.request));
    const result = await this.db.query<{ id: string }>(
      `/* aws-transient:store-saml-request */
       WITH at AS (SELECT ${DB_NOW_MS} AS now_ms)
       INSERT INTO ${TABLE} AS current
         (tenant_id, kind, id, payload, immutable_payload, created_at_ms,
          expires_at_ms, consumed_at_ms)
       SELECT $1, 'saml_request', $2, $3::jsonb, $4::jsonb,
              at.now_ms, $5::bigint, NULL FROM at
       WHERE $5::bigint > at.now_ms
         AND $5::bigint <= at.now_ms + ${MAX_SAML_REQUEST_FUTURE_MS}
       ON CONFLICT (tenant_id, kind, id) DO UPDATE
         SET payload = EXCLUDED.payload,
             consumed_at_ms = NULL
       WHERE current.immutable_payload = EXCLUDED.immutable_payload
         AND current.payload->>'spEntityId' = EXCLUDED.payload->>'spEntityId'
         AND current.expires_at_ms > ${DB_NOW_MS}
       RETURNING id`,
      [input.tenantId, input.request.requestId, payload, immutable, input.request.expiresAt]
    );
    if (result.rows.length !== 1) throw new Error('SAML request expired or binding conflict');
  }

  async consumeSamlRequest(input: ConsumeSamlRequestInput): Promise<SAMLRequestData | null> {
    assertTenantId(input.tenantId);
    assertIdentifier(input.spEntityId, 'SP entity ID', 4096);
    assertIdentifier(input.requestId, 'SAML request ID');
    const result = await this.db.query<StoredRow>(
      `/* aws-transient:consume-saml-request */
       UPDATE ${TABLE} SET consumed_at_ms = ${DB_NOW_MS}
       WHERE tenant_id = $1 AND kind = 'saml_request' AND id = $2
         AND payload->>'spEntityId' = $3
         AND immutable_payload->>'issuer' = $3
         AND consumed_at_ms IS NULL AND expires_at_ms > ${DB_NOW_MS}
       RETURNING payload, created_at_ms, expires_at_ms`,
      [input.tenantId, input.requestId, input.spEntityId]
    );
    return result.rows[0] ? readSamlRequest(result.rows[0], input) : null;
  }

  /** A short-lived tenant-scoped string slot for SAML continuation state. */
  async putKey(input: PutTransientKeyInput): Promise<void> {
    assertTenantId(input.tenantId);
    assertIdentifier(input.key, 'transient key', 4096);
    assertTtlMs(input.ttlMs);
    const payload = jsonObject({ value: input.value });
    await this.db.query<{ id: string }>(
      `/* aws-transient:put-key */
       WITH at AS (SELECT ${DB_NOW_MS} AS now_ms)
       INSERT INTO ${TABLE} AS current
         (tenant_id, kind, id, payload, immutable_payload, created_at_ms,
          expires_at_ms, consumed_at_ms)
       SELECT $1, 'kv', $2, $3::jsonb, '{}'::jsonb,
              at.now_ms, at.now_ms + $4::bigint, NULL FROM at
       ON CONFLICT (tenant_id, kind, id) DO UPDATE
         SET payload = EXCLUDED.payload,
             created_at_ms = EXCLUDED.created_at_ms,
             expires_at_ms = EXCLUDED.expires_at_ms,
             consumed_at_ms = NULL
       RETURNING id`,
      [input.tenantId, input.key, payload, input.ttlMs]
    );
  }

  async getKey(input: { tenantId: string; key: string }): Promise<string | null> {
    assertTenantId(input.tenantId);
    assertIdentifier(input.key, 'transient key', 4096);
    const result = await this.db.query<{ payload: unknown }>(
      `/* aws-transient:get-key */
       SELECT payload FROM ${TABLE}
       WHERE tenant_id = $1 AND kind = 'kv' AND id = $2
         AND consumed_at_ms IS NULL AND expires_at_ms > ${DB_NOW_MS}`,
      [input.tenantId, input.key]
    );
    if (!result.rows[0]) return null;
    const value = asObject(result.rows[0].payload).value;
    if (typeof value !== 'string') throw new Error('Transient key payload invalid');
    return value;
  }

  async deleteKey(input: { tenantId: string; key: string }): Promise<boolean> {
    assertTenantId(input.tenantId);
    assertIdentifier(input.key, 'transient key', 4096);
    const result = await this.db.query<{ id: string }>(
      `/* aws-transient:delete-key */
       UPDATE ${TABLE} SET consumed_at_ms = ${DB_NOW_MS}
       WHERE tenant_id = $1 AND kind = 'kv' AND id = $2
         AND consumed_at_ms IS NULL
       RETURNING id`,
      [input.tenantId, input.key]
    );
    return result.rows.length === 1;
  }

  /** Call from a bounded maintenance job; normal reads still enforce expiry. */
  async pruneExpired(limit = 1000): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error('Invalid prune limit');
    }
    const result = await this.db.query<{ id: string }>(
      `/* aws-transient:prune-expired */
       DELETE FROM ${TABLE}
       WHERE ctid IN (
         SELECT ctid FROM ${TABLE}
         WHERE expires_at_ms <= ${DB_NOW_MS}
         ORDER BY expires_at_ms LIMIT $1
       ) RETURNING id`,
      [limit]
    );
    return result.rowCount ?? result.rows.length;
  }
}
