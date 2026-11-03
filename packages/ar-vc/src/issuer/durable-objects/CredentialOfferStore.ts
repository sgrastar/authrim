import {
  initializeCredentialStoreSchema,
  VCI_INITIAL_SCHEMA,
  VCI_PRIMARY_KEY_MIGRATION,
  upgradeCredentialOfferIssuanceSchema,
} from '../../common/primary-key-schema.js';
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
/** An `issuing` claim that does not finish within this window becomes `failed`, never claimable. */
const ISSUANCE_LEASE_MS = 60_000;

export type CredentialOfferStatus = 'pending' | 'processing' | 'consumed' | 'locked' | 'expired';
export type CredentialOfferSubjectKind = 'end_user' | 'admin';
export type CredentialOfferIssuanceStatus = 'issuing' | 'issued' | 'failed';
export type AdminOfferProgressState =
  | 'pending'
  | 'fetched'
  | 'token_issued'
  | 'issued'
  | 'failed'
  | 'expired'
  | 'locked';

export interface AdminOfferProgress {
  offerId: string;
  state: AdminOfferProgressState;
  expiresAt: number;
  holderKeyThumbprint?: string;
}

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
  subjectKind: CredentialOfferSubjectKind;
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
  /** Defaults to `end_user`. */
  subjectKind?: CredentialOfferSubjectKind;
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
  | {
      reserved: false;
      reason:
        | 'not_found'
        | 'invalid_code'
        | 'invalid_tx_code'
        | 'tx_code_required'
        | 'tx_code_not_expected'
        | 'unavailable';
    };

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
  subject_kind: CredentialOfferSubjectKind;
  fetched_at: number | null;
}

interface IssuanceRow {
  [key: string]: SqlStorageValue;
  offer_id: string;
  tenant_id: string;
  status: CredentialOfferIssuanceStatus;
  access_token_jti: string;
  holder_jkt: string | null;
  lease_expires_at: number;
  created_at: number;
  updated_at: number;
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
    subjectKind: row.subject_kind ?? 'end_user',
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
    initializeCredentialStoreSchema(
      this.ctx.storage,
      VCI_INITIAL_SCHEMA,
      VCI_PRIMARY_KEY_MIGRATION,
      ['credential_offers', 'proof_nonces']
    );
    upgradeCredentialOfferIssuanceSchema(this.ctx.storage);
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
    const subjectKind = input.subjectKind ?? 'end_user';
    if (subjectKind !== 'end_user' && subjectKind !== 'admin') {
      throw new Error('vci_invalid_subject_kind');
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO credential_offers
       (id, tenant_id, user_id, credential_profile_id, credential_profile_version,
        credential_profile_snapshot_hash,
        credential_configuration_id, mapping_version_id, mapping_snapshot_hash,
        claim_manifest_hash, claims_json, code_hash, tx_code_hash, status,
        failed_attempts, max_attempts, created_at, expires_at, subject_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
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
      input.expiresAt,
      subjectKind
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
    // A missing or unexpected tx_code is a malformed request (OpenID4VCI §6.3), not a guess:
    // it neither counts as a failed attempt nor reserves the offer.
    if (row.tx_code_hash && !input.txCodeHash) {
      return { reserved: false, reason: 'tx_code_required' };
    }
    if (!row.tx_code_hash && input.txCodeHash) {
      return { reserved: false, reason: 'tx_code_not_expected' };
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
    // Changed rows come from RETURNING: on Cloudflare `rowsWritten` also counts index writes, so
    // an update of an indexed column (status, expires_at) reports 2 for one row.
    const updated = this.ctx.storage.sql
      .exec(
        `UPDATE credential_offers SET status = 'processing', reservation_id = ?, lease_expires_at = ?
       WHERE id = ? AND tenant_id = ? AND status = 'pending' AND expires_at > ?
       RETURNING id`,
        reservationId,
        leaseExpiresAt,
        id,
        tenantId,
        input.now
      )
      .toArray().length;
    if (updated !== 1) return { reserved: false, reason: 'unavailable' };
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
    const updated = this.ctx.storage.sql
      .exec(
        `UPDATE credential_offers SET status = 'consumed', reservation_id = NULL,
       lease_expires_at = NULL, expires_at = ?
       WHERE id = ? AND tenant_id = ? AND status = 'processing'
       AND reservation_id = ?
       RETURNING id`,
        input.claimsExpiresAt,
        required(input.id, 'offer_id'),
        required(input.tenantId, 'tenant_id'),
        required(input.reservationId, 'reservation_id')
      )
      .toArray().length;
    if (updated === 1) this.scheduleAlarm(input.claimsExpiresAt);
    return updated === 1;
  }

  releaseOfferRpc(input: { id: string; tenantId: string; reservationId: string }): boolean {
    const updated = this.ctx.storage.sql
      .exec(
        `UPDATE credential_offers SET status = 'pending', reservation_id = NULL,
       lease_expires_at = NULL WHERE id = ? AND tenant_id = ? AND status = 'processing'
       AND reservation_id = ? AND expires_at > ?
       RETURNING id`,
        required(input.id, 'offer_id'),
        required(input.tenantId, 'tenant_id'),
        required(input.reservationId, 'reservation_id'),
        Date.now()
      )
      .toArray().length;
    return updated === 1;
  }

  /** Records the first successful offer fetch only; later fetches keep the original time. */
  markOfferFetchedRpc(input: { id: string; tenantId: string; now: number }): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ id: string }>(
          `UPDATE credential_offers SET fetched_at = ?
           WHERE id = ? AND tenant_id = ? AND fetched_at IS NULL AND status = 'pending'
           AND expires_at > ? RETURNING id`,
          input.now,
          required(input.id, 'offer_id'),
          required(input.tenantId, 'tenant_id'),
          input.now
        )
        .toArray().length === 1
    );
  }

  /**
   * Starts the single issuance of a consumed offer. The insert succeeds only while the offer is
   * `consumed` and unexpired and no issuance row exists, so exactly one caller can ever win; every
   * concurrent or later caller (including one holding the same access token) is refused.
   */
  claimIssuanceRpc(input: {
    id: string;
    tenantId: string;
    accessTokenJti: string;
    now: number;
    leaseMs?: number;
  }): boolean {
    const id = required(input.id, 'offer_id');
    const tenantId = required(input.tenantId, 'tenant_id');
    const leaseExpiresAt = input.now + (input.leaseMs ?? ISSUANCE_LEASE_MS);
    const claimed =
      this.ctx.storage.sql
        .exec<{ offer_id: string }>(
          `INSERT INTO credential_offer_issuances
           (offer_id, tenant_id, status, access_token_jti, lease_expires_at, created_at, updated_at)
           SELECT id, tenant_id, 'issuing', ?, ?, ?, ? FROM credential_offers
           WHERE id = ? AND tenant_id = ? AND status = 'consumed' AND expires_at > ?
           ON CONFLICT(offer_id) DO NOTHING RETURNING offer_id`,
          required(input.accessTokenJti, 'access_token_jti'),
          leaseExpiresAt,
          input.now,
          input.now,
          id,
          tenantId,
          input.now
        )
        .toArray().length === 1;
    if (claimed) this.scheduleAlarm(leaseExpiresAt);
    return claimed;
  }

  /** `issuing → issued`; refused once the lease has run out (the issuance is then `failed`). */
  completeIssuanceRpc(input: {
    id: string;
    tenantId: string;
    accessTokenJti: string;
    /** RFC 7638 thumbprint of the holder key; null when the credential is not holder-bound. */
    holderJkt: string | null;
    now: number;
  }): boolean {
    this.expireStaleIssuances(input.now);
    return (
      this.ctx.storage.sql
        .exec<{ offer_id: string }>(
          `UPDATE credential_offer_issuances SET status = 'issued', holder_jkt = ?, updated_at = ?
           WHERE offer_id = ? AND tenant_id = ? AND status = 'issuing' AND access_token_jti = ?
           RETURNING offer_id`,
          input.holderJkt ?? null,
          input.now,
          required(input.id, 'offer_id'),
          required(input.tenantId, 'tenant_id'),
          required(input.accessTokenJti, 'access_token_jti')
        )
        .toArray().length === 1
    );
  }

  /** `issuing → failed`. An `issued` or already `failed` row is never touched. */
  failIssuanceRpc(input: {
    id: string;
    tenantId: string;
    accessTokenJti: string;
    now: number;
  }): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ offer_id: string }>(
          `UPDATE credential_offer_issuances SET status = 'failed', updated_at = ?
           WHERE offer_id = ? AND tenant_id = ? AND status = 'issuing' AND access_token_jti = ?
           RETURNING offer_id`,
          input.now,
          required(input.id, 'offer_id'),
          required(input.tenantId, 'tenant_id'),
          required(input.accessTokenJti, 'access_token_jti')
        )
        .toArray().length === 1
    );
  }

  /**
   * Progress of an admin offer for its owner. Null unless the offer is an admin offer of exactly
   * this tenant and admin; nothing else about the offer is revealed.
   */
  getAdminOfferProgressRpc(input: {
    id: string;
    tenantId: string;
    userId: string;
    now: number;
  }): AdminOfferProgress | null {
    const id = required(input.id, 'offer_id');
    const tenantId = required(input.tenantId, 'tenant_id');
    const row = this.getOfferRow(id, tenantId);
    if (!row || row.subject_kind !== 'admin' || row.user_id !== input.userId) return null;

    this.expireStaleIssuances(input.now);
    const issuance = this.ctx.storage.sql
      .exec<IssuanceRow>(
        `SELECT * FROM credential_offer_issuances WHERE offer_id = ? AND tenant_id = ?`,
        id,
        tenantId
      )
      .toArray()[0];
    const progress = (state: AdminOfferProgressState): AdminOfferProgress => ({
      offerId: id,
      state,
      expiresAt: row.expires_at,
    });

    if (issuance) {
      if (issuance.status === 'issued' && issuance.holder_jkt) {
        return { ...progress('issued'), holderKeyThumbprint: issuance.holder_jkt };
      }
      return progress(issuance.status === 'failed' ? 'failed' : 'token_issued');
    }
    if (row.status === 'locked') return progress('locked');
    if (row.status === 'expired' || row.expires_at <= input.now) return progress('expired');
    if (row.status === 'consumed') return progress('token_issued');
    // `processing` is a token exchange in flight: the wallet has necessarily fetched the offer.
    return progress(row.fetched_at !== null || row.status === 'processing' ? 'fetched' : 'pending');
  }

  private expireStaleIssuances(now: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE credential_offer_issuances SET status = 'failed', updated_at = ?
       WHERE status = 'issuing' AND lease_expires_at <= ?`,
      now,
      now
    );
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
      const updated = this.ctx.storage.sql
        .exec(
          `UPDATE proof_nonces SET status = 'processing', proof_fingerprint = ?,
         access_token_jti = ?, reservation_id = ?, lease_expires_at = ?
         WHERE id = ? AND tenant_id = ? AND status = 'issued' AND expires_at > ?
       RETURNING id`,
          input.proofFingerprint,
          required(input.accessTokenJti, 'access_token_jti'),
          reservationId,
          leaseExpiresAt,
          id,
          tenantId,
          input.now
        )
        .toArray().length;
      if (updated !== 1) return { reserved: false, reason: 'unavailable' };
      return { reserved: true, reservationId };
    } catch (error) {
      log.warn('Rejected duplicate VCI proof fingerprint', { nonceId: id }, error as Error);
      return { reserved: false, reason: 'replayed_proof' };
    }
  }

  completeProofNonceRpc(input: { id: string; tenantId: string; reservationId: string }): boolean {
    const updated = this.ctx.storage.sql
      .exec(
        `UPDATE proof_nonces SET status = 'consumed', reservation_id = NULL,
       lease_expires_at = NULL WHERE id = ? AND tenant_id = ? AND status = 'processing'
       AND reservation_id = ?
       RETURNING id`,
        required(input.id, 'nonce_id'),
        required(input.tenantId, 'tenant_id'),
        required(input.reservationId, 'reservation_id')
      )
      .toArray().length;
    return updated === 1;
  }

  releaseProofNonceRpc(input: { id: string; tenantId: string; reservationId: string }): boolean {
    const updated = this.ctx.storage.sql
      .exec(
        `UPDATE proof_nonces SET status = 'issued', proof_fingerprint = NULL,
       access_token_jti = NULL, reservation_id = NULL, lease_expires_at = NULL
       WHERE id = ? AND tenant_id = ? AND status = 'processing' AND reservation_id = ?
       AND expires_at > ?
       RETURNING id`,
        required(input.id, 'nonce_id'),
        required(input.tenantId, 'tenant_id'),
        required(input.reservationId, 'reservation_id'),
        Date.now()
      )
      .toArray().length;
    return updated === 1;
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
    this.expireStaleIssuances(now);
    // Only the claims are scrubbed: progress reads need just the offer and issuance rows.
    this.ctx.storage.sql.exec(
      `UPDATE credential_offers SET claims_json = '{}'
       WHERE status = 'consumed' AND expires_at <= ? AND claims_json <> '{}'`,
      now
    );
    // Issuance rows leave together with their offer (and before it).
    this.ctx.storage.sql.exec(
      `DELETE FROM credential_offer_issuances
       WHERE offer_id IN (SELECT id FROM credential_offers WHERE expires_at < ?)`,
      now - RETENTION_MS
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM credential_offers WHERE expires_at < ?`,
      now - RETENTION_MS
    );
    // A nonce that expired without ever carrying a proof proves nothing later (an expired nonce is
    // refused either way), and anyone can request one: it leaves at expiry, not after retention.
    this.ctx.storage.sql.exec(
      `DELETE FROM proof_nonces
       WHERE status = 'expired' AND proof_fingerprint IS NULL AND expires_at <= ?`,
      now
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
    const nextLease = this.ctx.storage.sql
      .exec<{ next_at: number | null }>(
        `SELECT MIN(lease_expires_at) AS next_at FROM credential_offer_issuances
         WHERE status = 'issuing'`
      )
      .one().next_at;
    const nextAlarm = [nextOffer, nextNonce, nextLease]
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
        case '/offer/fetched':
          return Response.json({ marked: this.markOfferFetchedRpc(body as never) });
        case '/issuance/claim':
          return Response.json({ claimed: this.claimIssuanceRpc(body as never) });
        case '/issuance/complete':
          return Response.json({ completed: this.completeIssuanceRpc(body as never) });
        case '/issuance/fail':
          return Response.json({ failed: this.failIssuanceRpc(body as never) });
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
