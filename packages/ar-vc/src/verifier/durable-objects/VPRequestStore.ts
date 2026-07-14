/** Region-sharded SQLite coordinator for OpenID4VP request state. */

import { DurableObject } from 'cloudflare:workers';
import type { SqlStorageValue } from '@cloudflare/workers-types';
import { createLogger } from '@authrim/ar-lib-core';
import type { Env, VPRequestState } from '../../types';

const log = createLogger().module('VC-VP-COORDINATOR');
const DEFAULT_LEASE_MS = 60_000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

interface VPRequestRow {
  [key: string]: SqlStorageValue;
  id: string;
  tenant_id: string;
  client_id: string;
  user_id: string | null;
  nonce: string;
  status_token_hash: string;
  presentation_definition_json: string | null;
  dcql_query_json: string | null;
  response_uri: string;
  response_mode: 'direct_post' | 'direct_post.jwt';
  status: VPRequestState['status'];
  response_fingerprint: string | null;
  reservation_id: string | null;
  lease_expires_at: number | null;
  verified_claims_json: string | null;
  error_code: string | null;
  error_description: string | null;
  created_at: number;
  expires_at: number;
}

export type ReserveVPResponseResult =
  | { reserved: true; reservationId: string; request: VPRequestState }
  | { reserved: false; reason: 'not_found' | 'expired' | 'replayed' | 'unavailable' };

function required(value: string, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`vp_missing_${field}`);
  return normalized;
}

function parseJsonObject(value: string | null): object | undefined {
  return value ? (JSON.parse(value) as object) : undefined;
}

function requestFromRow(row: VPRequestRow): VPRequestState {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    clientId: row.client_id,
    userId: row.user_id ?? undefined,
    nonce: row.nonce,
    state: row.id,
    presentationDefinition: parseJsonObject(row.presentation_definition_json),
    dcqlQuery: parseJsonObject(row.dcql_query_json) as VPRequestState['dcqlQuery'],
    responseUri: row.response_uri,
    responseMode: row.response_mode,
    status: row.status,
    verifiedClaims: row.verified_claims_json
      ? (JSON.parse(row.verified_claims_json) as Record<string, unknown>)
      : undefined,
    errorCode: row.error_code ?? undefined,
    errorDescription: row.error_description ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function extractRequestedClaimNames(row: VPRequestRow): Set<string> {
  const names = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)) names.add(value);
  };
  const dcql = parseJsonObject(row.dcql_query_json) as
    | {
        credentials?: Array<{ claims?: Array<{ path?: unknown[] }> }>;
      }
    | undefined;
  for (const credential of dcql?.credentials ?? []) {
    for (const claim of credential.claims ?? []) add(claim.path?.[0]);
  }
  const definition = parseJsonObject(row.presentation_definition_json) as
    | {
        input_descriptors?: Array<{ constraints?: { fields?: Array<{ path?: string[] }> } }>;
      }
    | undefined;
  for (const descriptor of definition?.input_descriptors ?? []) {
    for (const field of descriptor.constraints?.fields ?? []) {
      for (const path of field.path ?? []) {
        const bracket = path.match(/\[['"]([^'"]+)['"]\]$/u)?.[1];
        const dotted = path.match(/\.([A-Za-z0-9_:-]+)$/u)?.[1];
        add(bracket ?? dotted);
      }
    }
  }
  return new Set([...names].slice(0, 64));
}

function minimizeVerifiedClaims(
  claims: Record<string, unknown> | undefined,
  allowedClaimNames: Set<string>
): Record<string, string | number | boolean | null> | undefined {
  if (!claims) return undefined;
  const minimized: Record<string, string | number | boolean | null> = {};
  for (const [name, value] of Object.entries(claims).slice(0, 64)) {
    if (!allowedClaimNames.has(name)) continue;
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(name)) continue;
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= 2048)
    ) {
      minimized[name] = value as string | number | boolean | null;
    }
  }
  return minimized;
}

export class VPRequestStore extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env?: Env) {
    super(ctx, env ?? ({} as Env));
    void ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
    });
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS vp_requests (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        user_id TEXT,
        nonce TEXT NOT NULL UNIQUE,
        status_token_hash TEXT NOT NULL,
        presentation_definition_json TEXT,
        dcql_query_json TEXT,
        response_uri TEXT NOT NULL,
        response_mode TEXT NOT NULL CHECK (response_mode IN ('direct_post','direct_post.jwt')),
        status TEXT NOT NULL CHECK (status IN ('pending','processing','verified','failed','expired')),
        response_fingerprint TEXT UNIQUE,
        reservation_id TEXT,
        lease_expires_at INTEGER,
        verified_claims_json TEXT,
        error_code TEXT,
        error_description TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS vp_requests_expiry_idx ON vp_requests(status, expires_at);
    `);
  }

  createRequestRpc(input: VPRequestState): VPRequestState {
    const id = required(input.id, 'request_id');
    const tenantId = required(input.tenantId, 'tenant_id');
    if (input.expiresAt <= input.createdAt) throw new Error('vp_invalid_request_expiry');
    if (input.status !== 'pending') throw new Error('vp_invalid_initial_status');
    this.ctx.storage.sql.exec(
      `INSERT INTO vp_requests
       (id, tenant_id, client_id, user_id, nonce, status_token_hash, presentation_definition_json,
        dcql_query_json, response_uri, response_mode, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      id,
      tenantId,
      required(input.clientId, 'client_id'),
      input.userId ?? null,
      required(input.nonce, 'nonce'),
      required(input.statusTokenHash ?? '', 'status_token_hash'),
      input.presentationDefinition ? JSON.stringify(input.presentationDefinition) : null,
      input.dcqlQuery ? JSON.stringify(input.dcqlQuery) : null,
      required(input.responseUri, 'response_uri'),
      input.responseMode,
      input.createdAt,
      input.expiresAt
    );
    this.scheduleAlarm(input.expiresAt);
    return this.getRequestRequired(id, tenantId);
  }

  getRequestRpc(input: { id: string; tenantId: string; now?: number }): VPRequestState | null {
    const id = required(input.id, 'request_id');
    const tenantId = required(input.tenantId, 'tenant_id');
    const row = this.getRow(id, tenantId);
    if (!row) return null;
    const now = input.now ?? Date.now();
    if ((row.status === 'pending' || row.status === 'processing') && row.expires_at <= now) {
      this.ctx.storage.sql.exec(
        `UPDATE vp_requests SET status = 'expired', reservation_id = NULL,
         lease_expires_at = NULL WHERE id = ? AND tenant_id = ?`,
        id,
        tenantId
      );
      row.status = 'expired';
    }
    return requestFromRow(row);
  }

  getStatusRpc(input: {
    id: string;
    tenantId: string;
    statusTokenHash: string;
    now?: number;
  }): VPRequestState | null {
    const row = this.ctx.storage.sql
      .exec<VPRequestRow>(
        `SELECT * FROM vp_requests
         WHERE id = ? AND tenant_id = ? AND status_token_hash = ?`,
        required(input.id, 'request_id'),
        required(input.tenantId, 'tenant_id'),
        required(input.statusTokenHash, 'status_token_hash')
      )
      .toArray()[0];
    if (!row) return null;
    return this.getRequestRpc({ id: row.id, tenantId: row.tenant_id, now: input.now });
  }

  reserveResponseRpc(input: {
    id: string;
    tenantId: string;
    responseFingerprint: string;
    now: number;
    leaseMs?: number;
  }): ReserveVPResponseResult {
    const id = required(input.id, 'request_id');
    const tenantId = required(input.tenantId, 'tenant_id');
    const fingerprint = required(input.responseFingerprint, 'response_fingerprint');
    const row = this.getRow(id, tenantId);
    if (!row) return { reserved: false, reason: 'not_found' };

    if (row.status === 'processing' && row.lease_expires_at && row.lease_expires_at <= input.now) {
      this.ctx.storage.sql.exec(
        `UPDATE vp_requests SET status = 'pending', response_fingerprint = NULL,
         reservation_id = NULL, lease_expires_at = NULL WHERE id = ? AND tenant_id = ?
         AND status = 'processing' AND lease_expires_at <= ?`,
        id,
        tenantId,
        input.now
      );
      row.status = 'pending';
      row.response_fingerprint = null;
    }
    if (row.expires_at <= input.now) {
      this.ctx.storage.sql.exec(
        `UPDATE vp_requests SET status = 'expired', reservation_id = NULL,
         lease_expires_at = NULL WHERE id = ? AND tenant_id = ?`,
        id,
        tenantId
      );
      return { reserved: false, reason: 'expired' };
    }
    if (row.status !== 'pending') {
      return {
        reserved: false,
        reason: row.response_fingerprint === fingerprint ? 'replayed' : 'unavailable',
      };
    }
    const duplicate = this.ctx.storage.sql
      .exec<{
        id: string;
      }>(
        `SELECT id FROM vp_requests WHERE response_fingerprint = ? AND id <> ? LIMIT 1`,
        fingerprint,
        id
      )
      .toArray()[0];
    if (duplicate) return { reserved: false, reason: 'replayed' };

    const reservationId = crypto.randomUUID();
    const leaseExpiresAt = Math.min(
      input.now + Math.min(Math.max(input.leaseMs ?? DEFAULT_LEASE_MS, 5_000), 120_000),
      row.expires_at
    );
    try {
      const cursor = this.ctx.storage.sql.exec(
        `UPDATE vp_requests SET status = 'processing', response_fingerprint = ?,
         reservation_id = ?, lease_expires_at = ? WHERE id = ? AND tenant_id = ?
         AND status = 'pending' AND expires_at > ?`,
        fingerprint,
        reservationId,
        leaseExpiresAt,
        id,
        tenantId,
        input.now
      );
      if (cursor.rowsWritten !== 1) return { reserved: false, reason: 'unavailable' };
      return {
        reserved: true,
        reservationId,
        request: { ...requestFromRow(row), status: 'processing' },
      };
    } catch (error) {
      log.warn('Rejected duplicate VP response fingerprint', { requestId: id }, error as Error);
      return { reserved: false, reason: 'replayed' };
    }
  }

  completeResponseRpc(input: {
    id: string;
    tenantId: string;
    reservationId: string;
    verifiedClaims?: Record<string, unknown>;
  }): boolean {
    const row = this.getRow(
      required(input.id, 'request_id'),
      required(input.tenantId, 'tenant_id')
    );
    if (!row) return false;
    const minimizedClaims = minimizeVerifiedClaims(
      input.verifiedClaims,
      extractRequestedClaimNames(row)
    );
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE vp_requests SET status = 'verified', reservation_id = NULL,
       lease_expires_at = NULL, verified_claims_json = ?, error_code = NULL,
       error_description = NULL WHERE id = ? AND tenant_id = ? AND status = 'processing'
       AND reservation_id = ?`,
      minimizedClaims ? JSON.stringify(minimizedClaims) : null,
      required(input.id, 'request_id'),
      required(input.tenantId, 'tenant_id'),
      required(input.reservationId, 'reservation_id')
    );
    return cursor.rowsWritten === 1;
  }

  failResponseRpc(input: {
    id: string;
    tenantId: string;
    reservationId: string;
    errorCode: string;
    errorDescription?: string;
  }): boolean {
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE vp_requests SET status = 'failed', reservation_id = NULL,
       lease_expires_at = NULL, error_code = ?, error_description = ?
       WHERE id = ? AND tenant_id = ? AND status = 'processing' AND reservation_id = ?`,
      required(input.errorCode, 'error_code'),
      input.errorDescription?.slice(0, 500) ?? null,
      required(input.id, 'request_id'),
      required(input.tenantId, 'tenant_id'),
      required(input.reservationId, 'reservation_id')
    );
    return cursor.rowsWritten === 1;
  }

  releaseResponseRpc(input: { id: string; tenantId: string; reservationId: string }): boolean {
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE vp_requests SET status = 'pending', response_fingerprint = NULL,
       reservation_id = NULL, lease_expires_at = NULL WHERE id = ? AND tenant_id = ?
       AND status = 'processing' AND reservation_id = ? AND expires_at > ?`,
      required(input.id, 'request_id'),
      required(input.tenantId, 'tenant_id'),
      required(input.reservationId, 'reservation_id'),
      Date.now()
    );
    return cursor.rowsWritten === 1;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE vp_requests SET status = 'expired', reservation_id = NULL,
       lease_expires_at = NULL WHERE status IN ('pending','processing') AND expires_at <= ?`,
      now
    );
    this.ctx.storage.sql.exec(`DELETE FROM vp_requests WHERE expires_at < ?`, now - RETENTION_MS);
    const nextAlarm = this.ctx.storage.sql
      .exec<{ next_at: number | null }>(
        `SELECT MIN(CASE WHEN expires_at > ? THEN expires_at ELSE expires_at + ? END) AS next_at
         FROM vp_requests WHERE expires_at + ? > ?`,
        now,
        RETENTION_MS,
        RETENTION_MS,
        now
      )
      .one().next_at;
    if (nextAlarm !== null) await this.ctx.storage.setAlarm(Math.max(nextAlarm, now + 1_000));
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const body =
        request.method === 'POST' ? ((await request.json()) as Record<string, unknown>) : {};
      const id = url.searchParams.get('id') ?? (typeof body.id === 'string' ? body.id : '');
      const tenantId =
        url.searchParams.get('tenant_id') ??
        (typeof body.tenantId === 'string' ? body.tenantId : '');
      switch (url.pathname) {
        case '/create':
          return Response.json(this.createRequestRpc(body as unknown as VPRequestState), {
            status: 201,
          });
        case '/get': {
          const result = this.getRequestRpc({ id, tenantId });
          return result
            ? Response.json(result)
            : Response.json({ error: 'not_found' }, { status: 404 });
        }
        case '/status': {
          const result = this.getStatusRpc({
            id,
            tenantId,
            statusTokenHash: typeof body.statusTokenHash === 'string' ? body.statusTokenHash : '',
          });
          return result
            ? Response.json(result)
            : Response.json({ error: 'not_found' }, { status: 404 });
        }
        case '/reserve':
          return Response.json(this.reserveResponseRpc(body as never));
        case '/complete':
          return Response.json({ completed: this.completeResponseRpc(body as never) });
        case '/fail':
          return Response.json({ failed: this.failResponseRpc(body as never) });
        case '/release':
          return Response.json({ released: this.releaseResponseRpc(body as never) });
        default:
          return new Response('Not found', { status: 404 });
      }
    } catch (error) {
      log.error('VP coordinator operation failed', {}, error as Error);
      return Response.json({ error: 'internal_error' }, { status: 500 });
    }
  }

  private getRow(id: string, tenantId: string): VPRequestRow | null {
    return (
      this.ctx.storage.sql
        .exec<VPRequestRow>(
          `SELECT * FROM vp_requests WHERE id = ? AND tenant_id = ?`,
          id,
          tenantId
        )
        .toArray()[0] ?? null
    );
  }

  private getRequestRequired(id: string, tenantId: string): VPRequestState {
    const row = this.getRow(id, tenantId);
    if (!row) throw new Error('vp_request_create_failed');
    return requestFromRow(row);
  }

  private scheduleAlarm(expiresAt: number): void {
    this.ctx.storage
      .getAlarm()
      .then((current) => {
        if (current === null || expiresAt < current) return this.ctx.storage.setAlarm(expiresAt);
      })
      .catch((error: unknown) =>
        log.warn('Failed to schedule VP cleanup alarm', {}, error as Error)
      );
  }
}
