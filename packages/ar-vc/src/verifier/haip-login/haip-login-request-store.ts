/**
 * Login requests of the HAIP presentation (design D-L, S4): one row per request in the VP request
 * coordinator, apart from the other requests. Every change of state is a conditional UPDATE on
 * that one row.
 *
 *   pending -> processing (a wallet response is being verified, under a lease)
 *   processing -> verified | failed | pending (lease released)
 *   verified -> consumed (the admin sign-in takes the result once)
 *   pending | processing -> expired
 *
 * The browser that started the login holds a secret whose SHA-256 is `binding_hash`; only that
 * browser can read the progress or take the result. A same-device login adds a response code the
 * wallet's redirect carries to the browser, stored only as its hash.
 */

import type { SqlStorageValue } from '@cloudflare/workers-types';

export type HaipLoginFlow = 'cross_device' | 'same_device';
export type HaipLoginStatus =
  | 'pending'
  | 'processing'
  | 'verified'
  | 'failed'
  | 'expired'
  | 'consumed';

export const HAIP_LOGIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS haip_login_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  flow TEXT NOT NULL CHECK (flow IN ('cross_device', 'same_device')),
  binding_hash TEXT NOT NULL,
  client_id TEXT NOT NULL,
  credential_issuer TEXT NOT NULL,
  nonce TEXT NOT NULL,
  state TEXT NOT NULL,
  encryption_jwk TEXT NOT NULL,
  request_object TEXT NOT NULL,
  redirect_uri TEXT,
  status TEXT NOT NULL CHECK (status IN
    ('pending', 'processing', 'verified', 'failed', 'expired', 'consumed')),
  reservation_id TEXT,
  lease_expires_at INTEGER,
  response_fingerprint TEXT,
  response_code_hash TEXT,
  result_admin_user_id TEXT,
  result_holder_jkt TEXT,
  result_credential_id TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  verified_at INTEGER,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_haip_login_requests_expires ON haip_login_requests(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_haip_login_requests_fingerprint
  ON haip_login_requests(response_fingerprint) WHERE response_fingerprint IS NOT NULL;
`;

/** How long a verified result can still be taken. */
export const HAIP_LOGIN_CONSUME_WINDOW_MS = 120_000;
const LEASE_MS = 30_000;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const HASH = /^[A-Za-z0-9_-]{43}$/u;

export interface HaipLoginRequestInput {
  id: string;
  tenantId: string;
  flow: HaipLoginFlow;
  /** SHA-256 (base64url) of the secret the starting browser holds. */
  bindingHash: string;
  clientId: string;
  credentialIssuer: string;
  nonce: string;
  state: string;
  /** The request's ephemeral private key (JWK text) the answer is encrypted to. */
  encryptionJwk: string;
  requestObject: string;
  /** same_device: where the wallet sends the browser next (https, the response code is appended). */
  redirectUri?: string;
  createdAt: number;
  expiresAt: number;
}

/** What verifying a response needs. */
export interface HaipLoginRequestRecord {
  id: string;
  tenantId: string;
  flow: HaipLoginFlow;
  clientId: string;
  credentialIssuer: string;
  nonce: string;
  state: string;
  encryptionJwk: string;
  redirectUri?: string;
  status: HaipLoginStatus;
  createdAt: number;
  expiresAt: number;
}

export type ReserveHaipLoginResult =
  | { reserved: true; reservationId: string; request: HaipLoginRequestRecord }
  | { reserved: false; reason: 'not_found' | 'expired' | 'replayed' | 'unavailable' };

export interface HaipLoginResult {
  adminUserId: string;
  holderJkt: string;
  credentialId: string;
  verifiedAt: number;
}

interface Row {
  [key: string]: SqlStorageValue;
  id: string;
  tenant_id: string;
  flow: HaipLoginFlow;
  binding_hash: string;
  client_id: string;
  credential_issuer: string;
  nonce: string;
  state: string;
  encryption_jwk: string;
  request_object: string;
  redirect_uri: string | null;
  status: HaipLoginStatus;
  reservation_id: string | null;
  lease_expires_at: number | null;
  response_fingerprint: string | null;
  response_code_hash: string | null;
  result_admin_user_id: string | null;
  result_holder_jkt: string | null;
  result_credential_id: string | null;
  error_code: string | null;
  created_at: number;
  expires_at: number;
  verified_at: number | null;
}

function toRecord(row: Row): HaipLoginRequestRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    flow: row.flow,
    clientId: row.client_id,
    credentialIssuer: row.credential_issuer,
    nonce: row.nonce,
    state: row.state,
    encryptionJwk: row.encryption_jwk,
    ...(row.redirect_uri ? { redirectUri: row.redirect_uri } : {}),
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`haip_login_invalid_${field}`);
  return value;
}

export class HaipLoginRequestTable {
  constructor(private readonly sql: SqlStorage) {}

  initialize(): void {
    this.sql.exec(HAIP_LOGIN_SCHEMA);
  }

  create(input: HaipLoginRequestInput): void {
    if (input.flow !== 'cross_device' && input.flow !== 'same_device') {
      throw new Error('haip_login_invalid_flow');
    }
    if (!HASH.test(input.bindingHash)) throw new Error('haip_login_invalid_binding');
    if (input.flow === 'same_device') {
      let redirect: URL;
      try {
        redirect = new URL(input.redirectUri ?? '');
      } catch {
        throw new Error('haip_login_invalid_redirect_uri');
      }
      if (redirect.protocol !== 'https:' || redirect.hash || redirect.search) {
        throw new Error('haip_login_invalid_redirect_uri');
      }
    } else if (input.redirectUri !== undefined) {
      throw new Error('haip_login_invalid_redirect_uri');
    }
    if (input.expiresAt <= input.createdAt) throw new Error('haip_login_invalid_expiry');
    this.sql.exec(
      `INSERT INTO haip_login_requests
         (id, tenant_id, flow, binding_hash, client_id, credential_issuer, nonce, state,
          encryption_jwk, request_object, redirect_uri, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      nonEmpty(input.id, 'id'),
      nonEmpty(input.tenantId, 'tenant_id'),
      input.flow,
      input.bindingHash,
      nonEmpty(input.clientId, 'client_id'),
      nonEmpty(input.credentialIssuer, 'credential_issuer'),
      nonEmpty(input.nonce, 'nonce'),
      nonEmpty(input.state, 'state'),
      nonEmpty(input.encryptionJwk, 'encryption_jwk'),
      nonEmpty(input.requestObject, 'request_object'),
      input.redirectUri ?? null,
      input.createdAt,
      input.expiresAt
    );
  }

  /** The signed request object while a wallet may still answer it, else null. */
  requestObject(id: string, tenantId: string, now: number): string | null {
    const row = this.expireIfDue(this.row(id, tenantId), now);
    return row && row.status === 'pending' ? row.request_object : null;
  }

  reserve(id: string, tenantId: string, fingerprint: string, now: number): ReserveHaipLoginResult {
    let row = this.row(id, tenantId);
    if (!row) return { reserved: false, reason: 'not_found' };
    if (row.status === 'processing' && (row.lease_expires_at ?? 0) <= now) {
      this.sql.exec(
        `UPDATE haip_login_requests SET status = 'pending', reservation_id = NULL,
           lease_expires_at = NULL, response_fingerprint = NULL
         WHERE id = ? AND tenant_id = ? AND status = 'processing' AND lease_expires_at <= ?`,
        id,
        tenantId,
        now
      );
      row = this.row(id, tenantId);
      if (!row) return { reserved: false, reason: 'not_found' };
    }
    row = this.expireIfDue(row, now);
    if (!row || row.status === 'expired') return { reserved: false, reason: 'expired' };
    if (row.status !== 'pending') {
      return {
        reserved: false,
        reason: row.response_fingerprint === fingerprint ? 'replayed' : 'unavailable',
      };
    }
    const reused = this.sql
      .exec(
        'SELECT id FROM haip_login_requests WHERE response_fingerprint = ? AND id <> ? LIMIT 1',
        fingerprint,
        id
      )
      .toArray();
    if (reused.length > 0) return { reserved: false, reason: 'replayed' };
    const reservationId = crypto.randomUUID();
    const updated = this.sql
      .exec(
        `UPDATE haip_login_requests SET status = 'processing', reservation_id = ?,
           lease_expires_at = ?, response_fingerprint = ?
         WHERE id = ? AND tenant_id = ? AND status = 'pending' AND expires_at > ?
         RETURNING id`,
        reservationId,
        Math.min(now + LEASE_MS, row.expires_at),
        fingerprint,
        id,
        tenantId,
        now
      )
      .toArray();
    if (updated.length !== 1) return { reserved: false, reason: 'unavailable' };
    return { reserved: true, reservationId, request: { ...toRecord(row), status: 'processing' } };
  }

  complete(
    id: string,
    tenantId: string,
    reservationId: string,
    result: {
      adminUserId: string;
      holderJkt: string;
      credentialId: string;
      /** SHA-256 (base64url) of the response code a same-device redirect carries. */
      responseCodeHash?: string;
    },
    now: number
  ): boolean {
    return (
      this.sql
        .exec(
          `UPDATE haip_login_requests SET status = 'verified', reservation_id = NULL,
             lease_expires_at = NULL, result_admin_user_id = ?, result_holder_jkt = ?,
             result_credential_id = ?, response_code_hash = ?, verified_at = ?
           WHERE id = ? AND tenant_id = ? AND status = 'processing' AND reservation_id = ?
             AND (flow = 'cross_device' OR ? IS NOT NULL)
           RETURNING id`,
          nonEmpty(result.adminUserId, 'admin_user_id'),
          nonEmpty(result.holderJkt, 'holder_jkt'),
          nonEmpty(result.credentialId, 'credential_id'),
          result.responseCodeHash ?? null,
          now,
          id,
          tenantId,
          reservationId,
          result.responseCodeHash ?? null
        )
        .toArray().length === 1
    );
  }

  /** A failed request is final: a bad presentation is not retried. */
  fail(id: string, tenantId: string, reservationId: string, errorCode: string): boolean {
    return (
      this.sql
        .exec(
          `UPDATE haip_login_requests SET status = 'failed', reservation_id = NULL,
             lease_expires_at = NULL, error_code = ?
           WHERE id = ? AND tenant_id = ? AND status = 'processing' AND reservation_id = ?
           RETURNING id`,
          errorCode.slice(0, 64),
          id,
          tenantId,
          reservationId
        )
        .toArray().length === 1
    );
  }

  /** Give the request back after an infrastructure error, so the wallet can post again. */
  release(id: string, tenantId: string, reservationId: string, now: number): boolean {
    return (
      this.sql
        .exec(
          `UPDATE haip_login_requests SET status = 'pending', reservation_id = NULL,
             lease_expires_at = NULL, response_fingerprint = NULL
           WHERE id = ? AND tenant_id = ? AND status = 'processing' AND reservation_id = ?
             AND expires_at > ?
           RETURNING id`,
          id,
          tenantId,
          reservationId,
          now
        )
        .toArray().length === 1
    );
  }

  /** The progress, only to the browser that started the request. */
  status(
    id: string,
    tenantId: string,
    bindingHash: string,
    now: number
  ): {
    status: HaipLoginStatus;
    flow: HaipLoginFlow;
    expiresAt: number;
    errorCode?: string;
  } | null {
    const row = this.expireIfDue(this.row(id, tenantId), now);
    if (!row || row.binding_hash !== bindingHash) return null;
    return {
      status: row.status,
      flow: row.flow,
      expiresAt: row.expires_at,
      ...(row.error_code ? { errorCode: row.error_code } : {}),
    };
  }

  /**
   * Hand the verified result over once, to the browser that started the request (and, for a
   * same-device login, only with the response code its redirect carried).
   */
  consume(
    id: string,
    tenantId: string,
    bindingHash: string,
    responseCodeHash: string | undefined,
    now: number
  ): HaipLoginResult | null {
    const row = this.sql
      .exec<Row>(
        `UPDATE haip_login_requests SET status = 'consumed', consumed_at = ?
         WHERE id = ? AND tenant_id = ? AND binding_hash = ? AND status = 'verified'
           AND verified_at > ?
           AND (flow = 'cross_device' OR (response_code_hash IS NOT NULL AND response_code_hash = ?))
         RETURNING *`,
        now,
        id,
        tenantId,
        bindingHash,
        now - HAIP_LOGIN_CONSUME_WINDOW_MS,
        responseCodeHash ?? null
      )
      .toArray()[0];
    if (
      !row ||
      !row.result_admin_user_id ||
      !row.result_holder_jkt ||
      !row.result_credential_id ||
      !row.verified_at
    ) {
      return null;
    }
    return {
      adminUserId: row.result_admin_user_id,
      holderJkt: row.result_holder_jkt,
      credentialId: row.result_credential_id,
      verifiedAt: row.verified_at,
    };
  }

  /** Expire due requests, drop old ones; the next time to look again, or null. */
  sweep(now: number): number | null {
    this.sql.exec(
      `UPDATE haip_login_requests SET status = 'expired', reservation_id = NULL,
         lease_expires_at = NULL
       WHERE status IN ('pending', 'processing') AND expires_at <= ?`,
      now
    );
    this.sql.exec('DELETE FROM haip_login_requests WHERE expires_at < ?', now - RETENTION_MS);
    return this.sql
      .exec<{ next_at: number | null }>(
        `SELECT MIN(CASE WHEN expires_at > ? THEN expires_at ELSE expires_at + ? END) AS next_at
           FROM haip_login_requests`,
        now,
        RETENTION_MS
      )
      .one().next_at;
  }

  private row(id: string, tenantId: string): Row | null {
    return (
      this.sql
        .exec<Row>('SELECT * FROM haip_login_requests WHERE id = ? AND tenant_id = ?', id, tenantId)
        .toArray()[0] ?? null
    );
  }

  private expireIfDue(row: Row | null, now: number): Row | null {
    if (!row) return null;
    if ((row.status === 'pending' || row.status === 'processing') && row.expires_at <= now) {
      this.sql.exec(
        `UPDATE haip_login_requests SET status = 'expired', reservation_id = NULL,
           lease_expires_at = NULL
         WHERE id = ? AND tenant_id = ? AND status IN ('pending', 'processing')`,
        row.id,
        row.tenant_id
      );
      return { ...row, status: 'expired', reservation_id: null, lease_expires_at: null };
    }
    return row;
  }
}
