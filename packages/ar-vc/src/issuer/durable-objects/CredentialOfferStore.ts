/**
 * Region-sharded SQLite coordinator for OpenID4VCI one-time state.
 *
 * A single shard stores many offers and proof nonces. All security-sensitive state
 * transitions are synchronous conditional SQLite writes inside this Durable Object.
 */

import { DurableObject } from 'cloudflare:workers';
import type { SqlStorageValue } from '@cloudflare/workers-types';
import { createLogger } from '@authrim/ar-lib-core';
import type { Env } from '../../types';

const log = createLogger().module('VCI-COORDINATOR');
const DEFAULT_LEASE_MS = 30_000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

export type CredentialOfferStatus = 'pending' | 'processing' | 'consumed' | 'locked' | 'expired';

export interface CredentialOfferRecord {
  id: string;
  tenantId: string;
  userId: string;
  credentialProfileId: string;
  credentialProfileVersion: number;
  credentialProfileSnapshotHash: string;
  credentialConfigurationId: string;
  mappingVersionId: string;
  mappingSnapshotHash: string;
  claimManifestHash: string;
  claims: Record<string, unknown>;
  txCodeRequired: boolean;
  status: CredentialOfferStatus;
  failedAttempts: number;
  maxAttempts: number;
  createdAt: number;
  expiresAt: number;
}

export interface CreateCredentialOfferInput {
  id: string;
  tenantId: string;
  userId: string;
  credentialProfileId: string;
  credentialProfileVersion: number;
  credentialProfileSnapshotHash: string;
  credentialConfigurationId: string;
  mappingVersionId: string;
  mappingSnapshotHash: string;
  claimManifestHash: string;
  claims?: Record<string, unknown>;
  preAuthorizedCodeHash: string;
  txCodeHash?: string;
  maxAttempts?: number;
  createdAt: number;
  expiresAt: number;
}

export interface ReserveCredentialOfferInput {
  id: string;
  tenantId: string;
  preAuthorizedCodeHash: string;
  txCodeHash?: string;
  now: number;
  leaseMs?: number;
}

export type ReserveCredentialOfferResult =
  | { reserved: true; reservationId: string; offer: CredentialOfferRecord }
  | { reserved: false; reason: 'not_found' | 'invalid_code' | 'invalid_tx_code' | 'unavailable' };

export interface CreateProofNonceInput {
  id: string;
  tenantId: string;
  nonceHash: string;
  createdAt: number;
  expiresAt: number;
}

export interface ReserveProofNonceInput {
  id: string;
  tenantId: string;
  nonceHash: string;
  proofFingerprint: string;
  accessTokenJti: string;
  now: number;
  leaseMs?: number;
}

export type ReserveProofNonceResult =
  | { reserved: true; reservationId: string }
  | { reserved: false; reason: 'not_found' | 'invalid_nonce' | 'replayed_proof' | 'unavailable' };

interface OfferRow {
  [key: string]: SqlStorageValue;
  id: string;
  tenant_id: string;
  user_id: string;
  credential_profile_id: string;
  credential_profile_version: number;
  credential_profile_snapshot_hash: string;
  credential_configuration_id: string;
  mapping_version_id: string;
  mapping_snapshot_hash: string;
  claim_manifest_hash: string;
  claims_json: string;
  code_hash: string;
  tx_code_hash: string | null;
  status: CredentialOfferStatus;
  failed_attempts: number;
  max_attempts: number;
  reservation_id: string | null;
  lease_expires_at: number | null;
  created_at: number;
  expires_at: number;
}

interface NonceRow {
  [key: string]: SqlStorageValue;
  id: string;
  tenant_id: string;
  nonce_hash: string;
  status: 'issued' | 'processing' | 'consumed' | 'expired';
  proof_fingerprint: string | null;
  access_token_jti: string | null;
  reservation_id: string | null;
  lease_expires_at: number | null;
  created_at: number;
  expires_at: number;
}

function required(value: string, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`vci_missing_${field}`);
  return normalized;
}

function offerFromRow(row: OfferRow): CredentialOfferRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    credentialProfileId: row.credential_profile_id,
    credentialProfileVersion: row.credential_profile_version,
    credentialProfileSnapshotHash: row.credential_profile_snapshot_hash,
    credentialConfigurationId: row.credential_configuration_id,
    mappingVersionId: row.mapping_version_id,
    mappingSnapshotHash: row.mapping_snapshot_hash,
    claimManifestHash: row.claim_manifest_hash,
    claims: JSON.parse(row.claims_json) as Record<string, unknown>,
    txCodeRequired: row.tx_code_hash !== null,
    status: row.status,
    failedAttempts: row.failed_attempts,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export class CredentialOfferStoreV2 extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env?: Env) {
    super(ctx, env ?? ({} as Env));
    void ctx.blockConcurrencyWhile(async () => {
      this.initializeSchema();
    });
  }

  private initializeSchema(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS credential_offers (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        credential_profile_id TEXT NOT NULL,
        credential_profile_version INTEGER NOT NULL,
        credential_profile_snapshot_hash TEXT NOT NULL,
        credential_configuration_id TEXT NOT NULL,
        mapping_version_id TEXT NOT NULL,
        mapping_snapshot_hash TEXT NOT NULL,
        claim_manifest_hash TEXT NOT NULL,
        claims_json TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        tx_code_hash TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','processing','consumed','locked','expired')),
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        reservation_id TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS credential_offers_expiry_idx
        ON credential_offers(status, expires_at);
      CREATE TABLE IF NOT EXISTS proof_nonces (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        nonce_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('issued','processing','consumed','expired')),
        proof_fingerprint TEXT UNIQUE,
        access_token_jti TEXT,
        reservation_id TEXT,
        lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS proof_nonces_expiry_idx ON proof_nonces(status, expires_at);
    `);
  }

  createOfferRpc(input: CreateCredentialOfferInput): CredentialOfferRecord {
    const id = required(input.id, 'offer_id');
    const tenantId = required(input.tenantId, 'tenant_id');
    const userId = required(input.userId, 'user_id');
    const credentialProfileId = required(input.credentialProfileId, 'credential_profile_id');
    if (
      !Number.isSafeInteger(input.credentialProfileVersion) ||
      input.credentialProfileVersion < 1
    ) {
      throw new Error('vci_invalid_credential_profile_version');
    }
    const configurationId = required(
      input.credentialConfigurationId,
      'credential_configuration_id'
    );
    const credentialProfileSnapshotHash = required(
      input.credentialProfileSnapshotHash,
      'credential_profile_snapshot_hash'
    );
    const mappingVersionId = required(input.mappingVersionId, 'mapping_version_id');
    const mappingSnapshotHash = required(input.mappingSnapshotHash, 'mapping_snapshot_hash');
    const claimManifestHash = required(input.claimManifestHash, 'claim_manifest_hash');
    const codeHash = required(input.preAuthorizedCodeHash, 'code_hash');
    if (input.expiresAt <= input.createdAt) throw new Error('vci_invalid_offer_expiry');
    const maxAttempts = Math.min(Math.max(input.maxAttempts ?? 5, 1), 10);

    this.ctx.storage.sql.exec(
      `INSERT INTO credential_offers
       (id, tenant_id, user_id, credential_profile_id, credential_profile_version,
        credential_profile_snapshot_hash,
        credential_configuration_id, mapping_version_id, mapping_snapshot_hash,
        claim_manifest_hash, claims_json, code_hash, tx_code_hash, status,
        failed_attempts, max_attempts, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      id,
      tenantId,
      userId,
      credentialProfileId,
      input.credentialProfileVersion,
      credentialProfileSnapshotHash,
      configurationId,
      mappingVersionId,
      mappingSnapshotHash,
      claimManifestHash,
      JSON.stringify(input.claims ?? {}),
      codeHash,
      input.txCodeHash ?? null,
      maxAttempts,
      input.createdAt,
      input.expiresAt
    );
    this.scheduleAlarm(input.expiresAt);
    return this.getOfferRequired(id, tenantId);
  }

  getOfferRpc(input: { id: string; tenantId: string; now?: number }): CredentialOfferRecord | null {
    const id = required(input.id, 'offer_id');
    const tenantId = required(input.tenantId, 'tenant_id');
    const row = this.getOfferRow(id, tenantId);
    if (!row) return null;
    const now = input.now ?? Date.now();
    if ((row.status === 'pending' || row.status === 'processing') && row.expires_at <= now) {
      this.ctx.storage.sql.exec(
        `UPDATE credential_offers SET status = 'expired', reservation_id = NULL,
         lease_expires_at = NULL WHERE id = ? AND tenant_id = ?`,
        id,
        tenantId
      );
      return { ...offerFromRow(row), status: 'expired' };
    }
    return offerFromRow(row);
  }

  reserveOfferRpc(input: ReserveCredentialOfferInput): ReserveCredentialOfferResult {
    const id = required(input.id, 'offer_id');
    const tenantId = required(input.tenantId, 'tenant_id');
    const row = this.getOfferRow(id, tenantId);
    if (!row) return { reserved: false, reason: 'not_found' };

    if (row.status === 'processing' && row.lease_expires_at && row.lease_expires_at <= input.now) {
      this.ctx.storage.sql.exec(
        `UPDATE credential_offers SET status = 'pending', reservation_id = NULL,
         lease_expires_at = NULL WHERE id = ? AND tenant_id = ? AND status = 'processing'
         AND lease_expires_at <= ?`,
        id,
        tenantId,
        input.now
      );
      row.status = 'pending';
      row.reservation_id = null;
      row.lease_expires_at = null;
    }

    if (row.status !== 'pending' || row.expires_at <= input.now) {
      if (row.expires_at <= input.now && row.status === 'pending') {
        this.ctx.storage.sql.exec(
          `UPDATE credential_offers SET status = 'expired' WHERE id = ? AND tenant_id = ?`,
          id,
          tenantId
        );
      }
      return { reserved: false, reason: 'unavailable' };
    }
    if (row.code_hash !== input.preAuthorizedCodeHash) {
      return { reserved: false, reason: 'invalid_code' };
    }
    if (row.tx_code_hash && row.tx_code_hash !== input.txCodeHash) {
      const nextAttempts = row.failed_attempts + 1;
      const nextStatus = nextAttempts >= row.max_attempts ? 'locked' : 'pending';
      this.ctx.storage.sql.exec(
        `UPDATE credential_offers SET failed_attempts = ?, status = ?
         WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
        nextAttempts,
        nextStatus,
        id,
        tenantId
      );
      return { reserved: false, reason: 'invalid_tx_code' };
    }

    const reservationId = crypto.randomUUID();
    const leaseExpiresAt = Math.min(
      input.now + Math.min(Math.max(input.leaseMs ?? DEFAULT_LEASE_MS, 5_000), 120_000),
      row.expires_at
    );
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE credential_offers SET status = 'processing', reservation_id = ?, lease_expires_at = ?
       WHERE id = ? AND tenant_id = ? AND status = 'pending' AND expires_at > ?`,
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
      offer: { ...offerFromRow(row), status: 'processing' },
    };
  }

  completeOfferRpc(input: {
    id: string;
    tenantId: string;
    reservationId: string;
    claimsExpiresAt: number;
  }): boolean {
    if (!Number.isFinite(input.claimsExpiresAt) || input.claimsExpiresAt <= Date.now()) {
      throw new Error('vci_invalid_claims_expiry');
    }
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE credential_offers SET status = 'consumed', reservation_id = NULL,
       lease_expires_at = NULL, expires_at = ?
       WHERE id = ? AND tenant_id = ? AND status = 'processing'
       AND reservation_id = ?`,
      input.claimsExpiresAt,
      required(input.id, 'offer_id'),
      required(input.tenantId, 'tenant_id'),
      required(input.reservationId, 'reservation_id')
    );
    if (cursor.rowsWritten === 1) this.scheduleAlarm(input.claimsExpiresAt);
    return cursor.rowsWritten === 1;
  }

  releaseOfferRpc(input: { id: string; tenantId: string; reservationId: string }): boolean {
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE credential_offers SET status = 'pending', reservation_id = NULL,
       lease_expires_at = NULL WHERE id = ? AND tenant_id = ? AND status = 'processing'
       AND reservation_id = ? AND expires_at > ?`,
      required(input.id, 'offer_id'),
      required(input.tenantId, 'tenant_id'),
      required(input.reservationId, 'reservation_id'),
      Date.now()
    );
    return cursor.rowsWritten === 1;
  }

  createProofNonceRpc(input: CreateProofNonceInput): void {
    if (input.expiresAt <= input.createdAt) throw new Error('vci_invalid_nonce_expiry');
    this.ctx.storage.sql.exec(
      `INSERT INTO proof_nonces
       (id, tenant_id, nonce_hash, status, created_at, expires_at)
       VALUES (?, ?, ?, 'issued', ?, ?)`,
      required(input.id, 'nonce_id'),
      required(input.tenantId, 'tenant_id'),
      required(input.nonceHash, 'nonce_hash'),
      input.createdAt,
      input.expiresAt
    );
    this.scheduleAlarm(input.expiresAt);
  }

  reserveProofNonceRpc(input: ReserveProofNonceInput): ReserveProofNonceResult {
    const id = required(input.id, 'nonce_id');
    const tenantId = required(input.tenantId, 'tenant_id');
    const rows = this.ctx.storage.sql
      .exec<NonceRow>(`SELECT * FROM proof_nonces WHERE id = ? AND tenant_id = ?`, id, tenantId)
      .toArray();
    const row = rows[0];
    if (!row) return { reserved: false, reason: 'not_found' };

    if (row.status === 'processing' && row.lease_expires_at && row.lease_expires_at <= input.now) {
      this.ctx.storage.sql.exec(
        `UPDATE proof_nonces SET status = 'issued', proof_fingerprint = NULL,
         access_token_jti = NULL, reservation_id = NULL, lease_expires_at = NULL
         WHERE id = ? AND tenant_id = ? AND status = 'processing' AND lease_expires_at <= ?`,
        id,
        tenantId,
        input.now
      );
      row.status = 'issued';
      row.proof_fingerprint = null;
    }
    if (
      row.status !== 'issued' ||
      row.expires_at <= input.now ||
      row.nonce_hash !== input.nonceHash
    ) {
      return {
        reserved: false,
        reason: row.nonce_hash === input.nonceHash ? 'unavailable' : 'invalid_nonce',
      };
    }
    const duplicate = this.ctx.storage.sql
      .exec<{
        id: string;
      }>(
        `SELECT id FROM proof_nonces WHERE proof_fingerprint = ? AND id <> ? LIMIT 1`,
        required(input.proofFingerprint, 'proof_fingerprint'),
        id
      )
      .toArray()[0];
    if (duplicate) return { reserved: false, reason: 'replayed_proof' };

    const reservationId = crypto.randomUUID();
    const leaseExpiresAt = Math.min(
      input.now + Math.min(Math.max(input.leaseMs ?? DEFAULT_LEASE_MS, 5_000), 120_000),
      row.expires_at
    );
    try {
      const cursor = this.ctx.storage.sql.exec(
        `UPDATE proof_nonces SET status = 'processing', proof_fingerprint = ?,
         access_token_jti = ?, reservation_id = ?, lease_expires_at = ?
         WHERE id = ? AND tenant_id = ? AND status = 'issued' AND expires_at > ?`,
        input.proofFingerprint,
        required(input.accessTokenJti, 'access_token_jti'),
        reservationId,
        leaseExpiresAt,
        id,
        tenantId,
        input.now
      );
      if (cursor.rowsWritten !== 1) return { reserved: false, reason: 'unavailable' };
      return { reserved: true, reservationId };
    } catch (error) {
      log.warn('Rejected duplicate VCI proof fingerprint', { nonceId: id }, error as Error);
      return { reserved: false, reason: 'replayed_proof' };
    }
  }

  completeProofNonceRpc(input: { id: string; tenantId: string; reservationId: string }): boolean {
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE proof_nonces SET status = 'consumed', reservation_id = NULL,
       lease_expires_at = NULL WHERE id = ? AND tenant_id = ? AND status = 'processing'
       AND reservation_id = ?`,
      required(input.id, 'nonce_id'),
      required(input.tenantId, 'tenant_id'),
      required(input.reservationId, 'reservation_id')
    );
    return cursor.rowsWritten === 1;
  }

  releaseProofNonceRpc(input: { id: string; tenantId: string; reservationId: string }): boolean {
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE proof_nonces SET status = 'issued', proof_fingerprint = NULL,
       access_token_jti = NULL, reservation_id = NULL, lease_expires_at = NULL
       WHERE id = ? AND tenant_id = ? AND status = 'processing' AND reservation_id = ?
       AND expires_at > ?`,
      required(input.id, 'nonce_id'),
      required(input.tenantId, 'tenant_id'),
      required(input.reservationId, 'reservation_id'),
      Date.now()
    );
    return cursor.rowsWritten === 1;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `UPDATE credential_offers SET status = 'expired', reservation_id = NULL,
       lease_expires_at = NULL WHERE status IN ('pending','processing') AND expires_at <= ?`,
      now
    );
    this.ctx.storage.sql.exec(
      `UPDATE proof_nonces SET status = 'expired', reservation_id = NULL,
       lease_expires_at = NULL WHERE status IN ('issued','processing') AND expires_at <= ?`,
      now
    );
    this.ctx.storage.sql.exec(
      `UPDATE credential_offers SET claims_json = '{}'
       WHERE status = 'consumed' AND expires_at <= ? AND claims_json <> '{}'`,
      now
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM credential_offers WHERE expires_at < ?`,
      now - RETENTION_MS
    );
    this.ctx.storage.sql.exec(`DELETE FROM proof_nonces WHERE expires_at < ?`, now - RETENTION_MS);
    const nextOffer = this.ctx.storage.sql
      .exec<{ next_at: number | null }>(
        `SELECT MIN(CASE WHEN expires_at > ? THEN expires_at ELSE expires_at + ? END) AS next_at
         FROM credential_offers WHERE expires_at + ? > ?`,
        now,
        RETENTION_MS,
        RETENTION_MS,
        now
      )
      .one().next_at;
    const nextNonce = this.ctx.storage.sql
      .exec<{ next_at: number | null }>(
        `SELECT MIN(CASE WHEN expires_at > ? THEN expires_at ELSE expires_at + ? END) AS next_at
         FROM proof_nonces WHERE expires_at + ? > ?`,
        now,
        RETENTION_MS,
        RETENTION_MS,
        now
      )
      .one().next_at;
    const nextAlarm = [nextOffer, nextNonce]
      .filter((value): value is number => typeof value === 'number')
      .reduce<number | null>((earliest, value) => Math.min(earliest ?? value, value), null);
    if (nextAlarm !== null) await this.ctx.storage.setAlarm(Math.max(nextAlarm, now + 1_000));
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const body =
        request.method === 'POST' ? ((await request.json()) as Record<string, unknown>) : {};
      switch (url.pathname) {
        case '/create':
          return Response.json(this.createOfferRpc(body as unknown as CreateCredentialOfferInput), {
            status: 201,
          });
        case '/get': {
          const id = url.searchParams.get('id') ?? (typeof body.id === 'string' ? body.id : '');
          const tenantId =
            url.searchParams.get('tenant_id') ??
            (typeof body.tenantId === 'string' ? body.tenantId : '');
          const offer = this.getOfferRpc({ id, tenantId });
          return offer
            ? Response.json(offer)
            : Response.json({ error: 'not_found' }, { status: 404 });
        }
        case '/reserve':
          return Response.json(
            this.reserveOfferRpc(body as unknown as ReserveCredentialOfferInput)
          );
        case '/complete':
          return Response.json({ completed: this.completeOfferRpc(body as never) });
        case '/release':
          return Response.json({ released: this.releaseOfferRpc(body as never) });
        case '/nonce/create':
          this.createProofNonceRpc(body as unknown as CreateProofNonceInput);
          return Response.json({ created: true }, { status: 201 });
        case '/nonce/reserve':
          return Response.json(
            this.reserveProofNonceRpc(body as unknown as ReserveProofNonceInput)
          );
        case '/nonce/complete':
          return Response.json({ completed: this.completeProofNonceRpc(body as never) });
        case '/nonce/release':
          return Response.json({ released: this.releaseProofNonceRpc(body as never) });
        default:
          return new Response('Not found', { status: 404 });
      }
    } catch (error) {
      log.error('VCI coordinator operation failed', {}, error as Error);
      return Response.json({ error: 'internal_error' }, { status: 500 });
    }
  }

  private getOfferRow(id: string, tenantId: string): OfferRow | null {
    return (
      this.ctx.storage.sql
        .exec<OfferRow>(
          `SELECT * FROM credential_offers WHERE id = ? AND tenant_id = ?`,
          id,
          tenantId
        )
        .toArray()[0] ?? null
    );
  }

  private getOfferRequired(id: string, tenantId: string): CredentialOfferRecord {
    const row = this.getOfferRow(id, tenantId);
    if (!row) throw new Error('vci_offer_create_failed');
    return offerFromRow(row);
  }

  private scheduleAlarm(expiresAt: number): void {
    this.ctx.storage
      .getAlarm()
      .then((current) => {
        if (current === null || expiresAt < current) return this.ctx.storage.setAlarm(expiresAt);
      })
      .catch((error: unknown) =>
        log.warn('Failed to schedule VCI cleanup alarm', {}, error as Error)
      );
  }
}

/** Retained solely so the previous Durable Object class migration remains valid. */
export class CredentialOfferStore extends CredentialOfferStoreV2 {}
