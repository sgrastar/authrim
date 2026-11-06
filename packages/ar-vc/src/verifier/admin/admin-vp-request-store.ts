/**
 * Administrator presentation requests (OpenID4VP, second factor of an admin step-up).
 *
 * They live in their own table of the VP request coordinator, apart from the relying-party
 * requests: their acceptance rules are fixed and their result is consumed exactly once by
 * Management. Every change of state is a conditional UPDATE ... RETURNING on this one row.
 *
 *   pending -> processing (a wallet response is being verified, under a lease)
 *   processing -> verified | failed | pending (lease released)
 *   verified -> consumed (Management records the result on the admin session)
 *   pending | processing -> expired
 */

import type { SqlStorageValue } from '@cloudflare/workers-types';

export type AdminVPPurpose = 'step_up' | 'enroll';
/**
 * How the wallet answers: `direct_post` (QR, cross-device, with a match code) or `dc_api` (the
 * browser's Digital Credentials API, bound to the console origin, answer encrypted to the
 * request's ephemeral key).
 */
export type AdminVPMode = 'direct_post' | 'dc_api';
export type AdminVPStatus =
  | 'pending'
  | 'processing'
  | 'verified'
  | 'failed'
  | 'expired'
  | 'consumed';

export const ADMIN_VP_SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_vp_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  admin_user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('step_up', 'enroll')),
  holder_jkts_json TEXT NOT NULL,
  nonce TEXT NOT NULL,
  match_code TEXT NOT NULL,
  client_id TEXT NOT NULL,
  credential_issuer TEXT NOT NULL,
  transaction_data TEXT NOT NULL,
  request_object TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  mode TEXT NOT NULL DEFAULT 'direct_post',
  expected_origin TEXT,
  encryption_jwk TEXT,
  status TEXT NOT NULL CHECK (status IN
    ('pending', 'processing', 'verified', 'failed', 'expired', 'consumed')),
  reservation_id TEXT,
  lease_expires_at INTEGER,
  response_fingerprint TEXT,
  result_holder_jkt TEXT,
  result_credential_id TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  verified_at INTEGER,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_admin_vp_requests_expires ON admin_vp_requests(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_vp_requests_fingerprint
  ON admin_vp_requests(response_fingerprint) WHERE response_fingerprint IS NOT NULL;
`;

/** How long a verified result can still be consumed. */
export const ADMIN_VP_CONSUME_WINDOW_MS = 120_000;
const LEASE_MS = 30_000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

export interface AdminVPRequestInput {
  id: string;
  tenantId: string;
  adminUserId: string;
  sessionId: string;
  purpose: AdminVPPurpose;
  /**
   * step_up: the holder keys registered as the admin's active second factors (the presented key
   * must be one of them). enroll: the keys already registered (the presented key must not be).
   */
  holderJkts: string[];
  nonce: string;
  /** direct_post: the two digits; dc_api: empty (the origin binding replaces it). */
  matchCode: string;
  mode?: AdminVPMode;
  /** dc_api: the console origin the browser binds the answer to. */
  expectedOrigin?: string;
  /** dc_api: the ephemeral private key (JWK) the answer is encrypted to. */
  encryptionJwk?: string;
  clientId: string;
  credentialIssuer: string;
  transactionData: string;
  requestObject: string;
  /** Opaque to ar-vc: what the caller needs back with the result (small, string values). */
  context?: Record<string, string | null>;
  createdAt: number;
  expiresAt: number;
}

export interface AdminVPRequest {
  id: string;
  tenantId: string;
  adminUserId: string;
  sessionId: string;
  purpose: AdminVPPurpose;
  holderJkts: string[];
  nonce: string;
  matchCode: string;
  mode: AdminVPMode;
  encryptionJwk?: string;
  /** Digital Credentials API: the console origin the answer is bound to. */
  expectedOrigin?: string;
  clientId: string;
  credentialIssuer: string;
  transactionData: string;
  status: AdminVPStatus;
  errorCode?: string;
  createdAt: number;
  expiresAt: number;
}

export interface AdminVPResult {
  purpose: AdminVPPurpose;
  context: Record<string, string | null>;
  holderJkt: string;
  credentialId: string;
  verifiedAt: number;
}

export type ReserveAdminVPResult =
  | { reserved: true; reservationId: string; request: AdminVPRequest }
  | { reserved: false; reason: 'not_found' | 'expired' | 'replayed' | 'unavailable' };

interface Row {
  [key: string]: SqlStorageValue;
  id: string;
  tenant_id: string;
  admin_user_id: string;
  session_id: string;
  purpose: AdminVPPurpose;
  holder_jkts_json: string;
  nonce: string;
  match_code: string;
  client_id: string;
  credential_issuer: string;
  transaction_data: string;
  request_object: string;
  context_json: string;
  mode: AdminVPMode;
  expected_origin: string | null;
  encryption_jwk: string | null;
  status: AdminVPStatus;
  reservation_id: string | null;
  lease_expires_at: number | null;
  response_fingerprint: string | null;
  result_holder_jkt: string | null;
  result_credential_id: string | null;
  error_code: string | null;
  created_at: number;
  expires_at: number;
  verified_at: number | null;
  consumed_at: number | null;
}

function toRequest(row: Row): AdminVPRequest {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    adminUserId: row.admin_user_id,
    sessionId: row.session_id,
    purpose: row.purpose,
    holderJkts: JSON.parse(row.holder_jkts_json) as string[],
    nonce: row.nonce,
    matchCode: row.match_code,
    mode: row.mode === 'dc_api' ? 'dc_api' : 'direct_post',
    ...(row.encryption_jwk ? { encryptionJwk: row.encryption_jwk } : {}),
    ...(row.expected_origin ? { expectedOrigin: row.expected_origin } : {}),
    clientId: row.client_id,
    credentialIssuer: row.credential_issuer,
    transactionData: row.transaction_data,
    status: row.status,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`admin_vp_missing_${field}`);
  return value;
}

/** Store operations; the Durable Object serialises every call, the SQL guards every change. */
export class AdminVPRequestTable {
  constructor(private readonly sql: SqlStorage) {}

  initialize(): void {
    this.sql.exec(ADMIN_VP_SCHEMA);
    // Tables created before the Digital Credentials API mode get its columns.
    const columns = new Set(
      this.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('admin_vp_requests')")
        .toArray()
        .map((column) => column.name)
    );
    if (!columns.has('mode')) {
      this.sql.exec(
        "ALTER TABLE admin_vp_requests ADD COLUMN mode TEXT NOT NULL DEFAULT 'direct_post'"
      );
    }
    if (!columns.has('expected_origin')) {
      this.sql.exec('ALTER TABLE admin_vp_requests ADD COLUMN expected_origin TEXT');
    }
    if (!columns.has('encryption_jwk')) {
      this.sql.exec('ALTER TABLE admin_vp_requests ADD COLUMN encryption_jwk TEXT');
    }
  }

  create(input: AdminVPRequestInput): void {
    if (input.purpose !== 'step_up' && input.purpose !== 'enroll') {
      throw new Error('admin_vp_invalid_purpose');
    }
    const mode = input.mode ?? 'direct_post';
    if (mode === 'direct_post') {
      if (!/^\d{2}$/u.test(input.matchCode)) throw new Error('admin_vp_invalid_match_code');
    } else if (mode === 'dc_api') {
      if (input.matchCode !== '' || !input.expectedOrigin || !input.encryptionJwk) {
        throw new Error('admin_vp_invalid_dc_api_request');
      }
    } else {
      throw new Error('admin_vp_invalid_mode');
    }
    if (input.expiresAt <= input.createdAt) throw new Error('admin_vp_invalid_expiry');
    if (!Array.isArray(input.holderJkts) || input.holderJkts.length > 32) {
      throw new Error('admin_vp_invalid_holder_keys');
    }
    if (input.purpose === 'step_up' && input.holderJkts.length === 0) {
      throw new Error('admin_vp_no_registered_holder_key');
    }
    const context = JSON.stringify(input.context ?? {});
    if (
      context.length > 2048 ||
      Object.values(input.context ?? {}).some(
        (value) => value !== null && typeof value !== 'string'
      )
    ) {
      throw new Error('admin_vp_invalid_context');
    }
    this.sql.exec(
      `INSERT INTO admin_vp_requests
         (id, tenant_id, admin_user_id, session_id, purpose, holder_jkts_json, nonce, match_code,
          client_id, credential_issuer, transaction_data, request_object, context_json, mode,
          expected_origin, encryption_jwk, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      nonEmpty(input.id, 'id'),
      nonEmpty(input.tenantId, 'tenant_id'),
      nonEmpty(input.adminUserId, 'admin_user_id'),
      nonEmpty(input.sessionId, 'session_id'),
      input.purpose,
      JSON.stringify(input.holderJkts),
      nonEmpty(input.nonce, 'nonce'),
      input.matchCode,
      nonEmpty(input.clientId, 'client_id'),
      nonEmpty(input.credentialIssuer, 'credential_issuer'),
      nonEmpty(input.transactionData, 'transaction_data'),
      nonEmpty(input.requestObject, 'request_object'),
      context,
      mode,
      input.expectedOrigin ?? null,
      input.encryptionJwk ?? null,
      input.createdAt,
      input.expiresAt
    );
  }

  /** The signed request object while a wallet may still answer it, else null. */
  requestObject(id: string, tenantId: string, now: number): string | null {
    const row = this.expireIfDue(this.row(id, tenantId), now);
    // A Digital Credentials API request goes through the browser, never by reference.
    return row && row.status === 'pending' && row.mode === 'direct_post'
      ? row.request_object
      : null;
  }

  reserve(
    id: string,
    tenantId: string,
    fingerprint: string,
    now: number,
    mode: AdminVPMode = 'direct_post'
  ): ReserveAdminVPResult {
    let row = this.row(id, tenantId);
    // An answer arrives only the way the request asked for it.
    if (!row || row.mode !== mode) return { reserved: false, reason: 'not_found' };
    if (row.status === 'processing' && (row.lease_expires_at ?? 0) <= now) {
      this.sql.exec(
        `UPDATE admin_vp_requests SET status = 'pending', reservation_id = NULL,
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
        'SELECT id FROM admin_vp_requests WHERE response_fingerprint = ? AND id <> ? LIMIT 1',
        fingerprint,
        id
      )
      .toArray();
    if (reused.length > 0) return { reserved: false, reason: 'replayed' };

    const reservationId = crypto.randomUUID();
    const updated = this.sql
      .exec(
        `UPDATE admin_vp_requests SET status = 'processing', reservation_id = ?,
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
    return { reserved: true, reservationId, request: { ...toRequest(row), status: 'processing' } };
  }

  complete(
    id: string,
    tenantId: string,
    reservationId: string,
    result: { holderJkt: string; credentialId: string },
    now: number
  ): boolean {
    return (
      this.sql
        .exec(
          `UPDATE admin_vp_requests SET status = 'verified', reservation_id = NULL,
             lease_expires_at = NULL, result_holder_jkt = ?, result_credential_id = ?,
             verified_at = ?
           WHERE id = ? AND tenant_id = ? AND status = 'processing' AND reservation_id = ?
           RETURNING id`,
          nonEmpty(result.holderJkt, 'holder_jkt'),
          nonEmpty(result.credentialId, 'credential_id'),
          now,
          id,
          tenantId,
          reservationId
        )
        .toArray().length === 1
    );
  }

  /** A failed request is final: a wrong match code or a bad presentation is not retried. */
  fail(id: string, tenantId: string, reservationId: string, errorCode: string): boolean {
    return (
      this.sql
        .exec(
          `UPDATE admin_vp_requests SET status = 'failed', reservation_id = NULL,
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
          `UPDATE admin_vp_requests SET status = 'pending', reservation_id = NULL,
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

  /** The progress Management shows, only to the admin session that asked for the request. */
  status(
    id: string,
    tenantId: string,
    adminUserId: string,
    sessionId: string,
    now: number
  ): { status: AdminVPStatus; expiresAt: number; errorCode?: string } | null {
    const row = this.expireIfDue(this.row(id, tenantId), now);
    if (!row || row.admin_user_id !== adminUserId || row.session_id !== sessionId) return null;
    return {
      status: row.status,
      expiresAt: row.expires_at,
      ...(row.error_code ? { errorCode: row.error_code } : {}),
    };
  }

  /** Hand the verified result over once, to the admin session that asked for it. */
  consume(
    id: string,
    tenantId: string,
    adminUserId: string,
    sessionId: string,
    now: number
  ): AdminVPResult | null {
    const row = this.sql
      .exec<Row>(
        `UPDATE admin_vp_requests SET status = 'consumed', consumed_at = ?
         WHERE id = ? AND tenant_id = ? AND admin_user_id = ? AND session_id = ?
           AND status = 'verified' AND verified_at > ?
         RETURNING *`,
        now,
        id,
        tenantId,
        adminUserId,
        sessionId,
        now - ADMIN_VP_CONSUME_WINDOW_MS
      )
      .toArray()[0];
    if (!row || !row.result_holder_jkt || !row.result_credential_id || !row.verified_at) {
      return null;
    }
    return {
      purpose: row.purpose,
      context: JSON.parse(row.context_json) as Record<string, string | null>,
      holderJkt: row.result_holder_jkt,
      credentialId: row.result_credential_id,
      verifiedAt: row.verified_at,
    };
  }

  /** Expire due requests, drop old ones; the next time to look again, or null. */
  sweep(now: number): number | null {
    this.sql.exec(
      `UPDATE admin_vp_requests SET status = 'expired', reservation_id = NULL,
         lease_expires_at = NULL
       WHERE status IN ('pending', 'processing') AND expires_at <= ?`,
      now
    );
    this.sql.exec('DELETE FROM admin_vp_requests WHERE expires_at < ?', now - RETENTION_MS);
    const next = this.sql
      .exec<{ next_at: number | null }>(
        `SELECT MIN(CASE WHEN expires_at > ? THEN expires_at ELSE expires_at + ? END) AS next_at
           FROM admin_vp_requests`,
        now,
        RETENTION_MS
      )
      .one().next_at;
    return next;
  }

  private row(id: string, tenantId: string): Row | null {
    return (
      this.sql
        .exec<Row>('SELECT * FROM admin_vp_requests WHERE id = ? AND tenant_id = ?', id, tenantId)
        .toArray()[0] ?? null
    );
  }

  private expireIfDue(row: Row | null, now: number): Row | null {
    if (!row) return null;
    if ((row.status === 'pending' || row.status === 'processing') && row.expires_at <= now) {
      this.sql.exec(
        `UPDATE admin_vp_requests SET status = 'expired', reservation_id = NULL,
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
