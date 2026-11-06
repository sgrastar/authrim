import { isConfiguredShard } from '../utils/configured-shard';
import { runSamlDrCoveredOperation } from '@authrim/ar-lib-core/services/tenant-portability/saml-dr-writer';
import { WorkerEntrypoint } from 'cloudflare:workers';
import type {
  AdminCredentialOfferStatus,
  AdminPresentationRef,
  AdminPresentationResult,
  AdminPresentationStatus,
  CreateAdminPresentationInput,
  CreateAdminPresentationResult,
  CreateAdminCredentialOfferServiceInput,
  CreateAdminCredentialOfferServiceResult,
  CreateCredentialOfferServiceInput,
  CreateCredentialOfferServiceResult,
} from '@authrim/ar-lib-core';
import { ADMIN_CREDENTIAL_CONFIGURATION_ID, isValidTenantIdentifier } from '@authrim/ar-lib-core';
import type { Env } from '../types';
import {
  consumeAdminPresentation,
  createAdminPresentationRequest,
  getAdminPresentationStatus,
} from '../verifier/admin/admin-vp-service';
import type {
  AdminOfferProgress,
  CreateCredentialOfferInput,
} from '../issuer/durable-objects/CredentialOfferStore';
import {
  generatePreAuthorizedCode,
  getCredentialOfferStoreById,
  getCredentialOfferStoreForNewOffer,
} from '../utils/credential-offer-sharding';
import { generateRandomString, hashTransactionCode, sha256Base64url } from '../utils/crypto';

const DEFAULT_EXPIRY_SECONDS = 300;
const MIN_EXPIRY_SECONDS = 60;
const MAX_EXPIRY_SECONDS = 900;
const MAX_CLAIMS_BYTES = 32 * 1024;
const MAX_CLAIMS = 128;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SNAPSHOT_HASH = /^[A-Za-z0-9_-]{32,128}$/;

/** Admin offers always require a 6-digit transaction code and live five minutes. */
const ADMIN_OFFER_EXPIRY_SECONDS = 300;

/**
 * Fixed values stored in the offer columns that are NOT NULL for Credential Profile offers
 * (profile, mapping, claim manifest). Admin offers carry no profile and no claims: the credential's
 * claims come from the issuance-time eligibility check. The hashes are digests of constant strings
 * so the columns hold valid-looking, non-secret evidence that can never match a real profile.
 */
const ADMIN_OFFER_PROFILE_ID = 'admin';
const ADMIN_OFFER_PROFILE_VERSION = 1;
const ADMIN_OFFER_MAPPING_VERSION_ID = 'admin';
const ADMIN_OFFER_SNAPSHOT_CONTRACT = 'authrim:admin-credential-offer-profile:v1';
const ADMIN_OFFER_MAPPING_CONTRACT = 'authrim:admin-credential-offer-mapping:v1';

type CredentialOfferStoreRpcStub = {
  createOfferRpc(input: CreateCredentialOfferInput): Promise<unknown>;
  getAdminOfferProgressRpc(input: {
    id: string;
    tenantId: string;
    userId: string;
    now: number;
  }): Promise<AdminOfferProgress | null>;
};

function requireIdentifier(value: string, field: string): string {
  const normalized = value?.trim();
  if (!normalized || !SAFE_IDENTIFIER.test(normalized)) {
    throw new Error(`invalid_${field}`);
  }
  return normalized;
}

function normalizeIssuer(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('invalid_credential_issuer');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  return url.toString().replace(/\/$/, '');
}

function validateClaims(
  claims: Record<string, unknown>,
  manifest: string[]
): { claimsJson: string; manifest: string[] } {
  const normalizedManifest = [...new Set(manifest.map((name) => name.trim()))].sort();
  if (
    normalizedManifest.length === 0 ||
    normalizedManifest.length > MAX_CLAIMS ||
    normalizedManifest.some((name) => !SAFE_IDENTIFIER.test(name))
  ) {
    throw new Error('invalid_claim_manifest');
  }

  const claimNames = Object.keys(claims).sort();
  if (
    claimNames.length !== normalizedManifest.length ||
    claimNames.some((name, index) => name !== normalizedManifest[index])
  ) {
    throw new Error('claim_manifest_mismatch');
  }

  const claimsJson = JSON.stringify(claims);
  if (new TextEncoder().encode(claimsJson).byteLength > MAX_CLAIMS_BYTES) {
    throw new Error('claims_too_large');
  }
  return { claimsJson, manifest: normalizedManifest };
}

function generateNumericTransactionCode(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String((bytes[0] ?? 0) % 1_000_000).padStart(6, '0');
}

async function verifyProfileContract(
  env: Env,
  input: CreateCredentialOfferServiceInput,
  manifest: string[]
): Promise<boolean> {
  const secret = env.VC_PROFILE_CONTRACT_HMAC_SECRET;
  if (
    !secret ||
    secret.length < 32 ||
    !SNAPSHOT_HASH.test(input.credentialProfileContractSignature)
  ) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const encoded = input.credentialProfileContractSignature.replace(/-/g, '+').replace(/_/g, '/');
  const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  const signature = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    new TextEncoder().encode(
      JSON.stringify([
        input.tenantId,
        input.credentialProfileId,
        input.credentialProfileVersion,
        input.credentialProfileSnapshotHash,
        input.credentialConfigurationId,
        input.mappingVersionId,
        input.mappingSnapshotHash,
        manifest,
      ])
    )
  );
}

/** Same-device and cross-device offer by reference (OpenID4VCI §4.1.3). */
function toCredentialOfferQrValue(credentialOfferUri: string): string {
  return `openid-credential-offer://?credential_offer_uri=${encodeURIComponent(credentialOfferUri)}`;
}

/** RPC-only facade. It is not mounted on ar-vc's public Hono routes. */
export class VCIssuerEntrypoint extends WorkerEntrypoint<Env> {
  async createCredentialOffer(
    input: CreateCredentialOfferServiceInput
  ): Promise<CreateCredentialOfferServiceResult> {
    return runSamlDrCoveredOperation(this.env, this.ctx, async (env) => {
      if (!isValidTenantIdentifier(input.tenantId)) {
        throw new Error('invalid_tenant_id');
      }
      const userId = requireIdentifier(input.userId, 'user_id');
      const credentialProfileId = requireIdentifier(
        input.credentialProfileId,
        'credential_profile_id'
      );
      const credentialConfigurationId = requireIdentifier(
        input.credentialConfigurationId,
        'credential_configuration_id'
      );
      // Admin credentials have their own issuance path; Credential Profiles cannot offer them.
      if (credentialConfigurationId === ADMIN_CREDENTIAL_CONFIGURATION_ID) {
        throw new Error('reserved_credential_configuration');
      }
      const mappingVersionId = requireIdentifier(input.mappingVersionId, 'mapping_version_id');
      if (
        !Number.isSafeInteger(input.credentialProfileVersion) ||
        input.credentialProfileVersion < 1
      ) {
        throw new Error('invalid_credential_profile_version');
      }
      if (!SNAPSHOT_HASH.test(input.mappingSnapshotHash)) {
        throw new Error('invalid_mapping_snapshot_hash');
      }
      if (!SNAPSHOT_HASH.test(input.credentialProfileSnapshotHash)) {
        throw new Error('invalid_credential_profile_snapshot_hash');
      }
      const credentialIssuer = normalizeIssuer(input.credentialIssuer);
      const validated = validateClaims(input.claims, input.claimManifest);
      if (!(await verifyProfileContract(env, input, validated.manifest))) {
        throw new Error('invalid_credential_profile_contract');
      }
      const claimManifestHash = await sha256Base64url(JSON.stringify(validated.manifest));

      const requestedExpiry = input.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS;
      if (!Number.isFinite(requestedExpiry)) {
        throw new Error('invalid_offer_expiry');
      }
      const expiresInSeconds = Math.min(
        Math.max(Math.trunc(requestedExpiry), MIN_EXPIRY_SECONDS),
        MAX_EXPIRY_SECONDS
      );
      const createdAt = Date.now();
      const expiresAt = createdAt + expiresInSeconds * 1000;
      const { stub, offerId } = await getCredentialOfferStoreForNewOffer(
        env,
        input.tenantId,
        userId,
        crypto.randomUUID()
      );
      const preAuthorizedCode = generatePreAuthorizedCode(offerId, generateRandomString(32));
      const transactionCode = input.transactionCodeRequired
        ? generateNumericTransactionCode()
        : undefined;

      await (stub as unknown as CredentialOfferStoreRpcStub).createOfferRpc({
        id: offerId,
        tenantId: input.tenantId,
        userId,
        credentialProfileId,
        credentialProfileVersion: input.credentialProfileVersion,
        credentialProfileSnapshotHash: input.credentialProfileSnapshotHash,
        credentialConfigurationId,
        mappingVersionId,
        mappingSnapshotHash: input.mappingSnapshotHash,
        claimManifestHash,
        claims: JSON.parse(validated.claimsJson) as Record<string, unknown>,
        preAuthorizedCodeHash: await sha256Base64url(preAuthorizedCode),
        txCodeHash: transactionCode
          ? await hashTransactionCode(
              env.VC_TRANSACTION_CODE_HMAC_SECRET,
              input.tenantId,
              offerId,
              transactionCode
            )
          : undefined,
        createdAt,
        expiresAt,
      });

      const credentialOfferUri = `${credentialIssuer}/vci/offers/${encodeURIComponent(preAuthorizedCode)}`;
      return {
        offerId,
        credentialOfferUri,
        credentialOffer: toCredentialOfferQrValue(credentialOfferUri),
        expiresAt,
        claimManifestHash,
        ...(transactionCode ? { transactionCode } : {}),
      };
    });
  }

  /**
   * Offer of the admin credential to an administrator's own wallet (design D4). The transaction
   * code is always required and the offer stores no claims: `email` and `name` come from the
   * eligibility check at issuance time.
   */
  async createAdminCredentialOffer(
    input: CreateAdminCredentialOfferServiceInput
  ): Promise<CreateAdminCredentialOfferServiceResult> {
    return runSamlDrCoveredOperation(this.env, this.ctx, async (env) => {
      if (!isValidTenantIdentifier(input.tenantId)) {
        throw new Error('invalid_tenant_id');
      }
      const adminUserId = requireIdentifier(input.adminUserId, 'admin_user_id');
      const credentialIssuer = normalizeIssuer(input.credentialIssuer);

      const createdAt = Date.now();
      const expiresAt = createdAt + ADMIN_OFFER_EXPIRY_SECONDS * 1000;
      const { stub, offerId } = await getCredentialOfferStoreForNewOffer(
        env,
        input.tenantId,
        adminUserId,
        crypto.randomUUID()
      );
      const preAuthorizedCode = generatePreAuthorizedCode(offerId, generateRandomString(32));
      const transactionCode = generateNumericTransactionCode();

      await (stub as unknown as CredentialOfferStoreRpcStub).createOfferRpc({
        id: offerId,
        tenantId: input.tenantId,
        userId: adminUserId,
        subjectKind: 'admin',
        credentialProfileId: ADMIN_OFFER_PROFILE_ID,
        credentialProfileVersion: ADMIN_OFFER_PROFILE_VERSION,
        credentialProfileSnapshotHash: await sha256Base64url(ADMIN_OFFER_SNAPSHOT_CONTRACT),
        credentialConfigurationId: ADMIN_CREDENTIAL_CONFIGURATION_ID,
        mappingVersionId: ADMIN_OFFER_MAPPING_VERSION_ID,
        mappingSnapshotHash: await sha256Base64url(ADMIN_OFFER_MAPPING_CONTRACT),
        claimManifestHash: await sha256Base64url(JSON.stringify([])),
        claims: {},
        preAuthorizedCodeHash: await sha256Base64url(preAuthorizedCode),
        txCodeHash: await hashTransactionCode(
          env.VC_TRANSACTION_CODE_HMAC_SECRET,
          input.tenantId,
          offerId,
          transactionCode
        ),
        createdAt,
        expiresAt,
      });

      const credentialOfferUri = `${credentialIssuer}/vci/offers/${encodeURIComponent(preAuthorizedCode)}`;
      return {
        offerId,
        credentialOfferUri,
        credentialOffer: toCredentialOfferQrValue(credentialOfferUri),
        expiresAt,
        transactionCode,
      };
    });
  }

  /** Start an administrator presentation (second factor of a step-up, or its enrolment). */
  async createAdminPresentationRequest(
    input: CreateAdminPresentationInput
  ): Promise<CreateAdminPresentationResult> {
    return runSamlDrCoveredOperation(this.env, this.ctx, (env) =>
      createAdminPresentationRequest(env, input)
    );
  }

  /** Null unless the request is one of exactly this admin session. */
  async getAdminPresentationStatus(
    input: AdminPresentationRef
  ): Promise<{ status: AdminPresentationStatus; expiresAt: number; errorCode?: string } | null> {
    return runSamlDrCoveredOperation(this.env, this.ctx, (env) =>
      getAdminPresentationStatus(env, input)
    );
  }

  /** The verified result, once, to the admin session that asked for it. */
  async consumeAdminPresentation(
    input: AdminPresentationRef
  ): Promise<AdminPresentationResult | null> {
    return runSamlDrCoveredOperation(this.env, this.ctx, (env) =>
      consumeAdminPresentation(env, input)
    );
  }

  /** Null unless the offer is an admin offer of exactly this tenant and administrator. */
  async getAdminCredentialOfferStatus(input: {
    tenantId: string;
    adminUserId: string;
    offerId: string;
  }): Promise<AdminCredentialOfferStatus | null> {
    return runSamlDrCoveredOperation(this.env, this.ctx, async (env) => {
      if (!isValidTenantIdentifier(input.tenantId)) {
        throw new Error('invalid_tenant_id');
      }
      const adminUserId = requireIdentifier(input.adminUserId, 'admin_user_id');
      let store: ReturnType<typeof getCredentialOfferStoreById>;
      try {
        store = getCredentialOfferStoreById(env, input.offerId, input.tenantId);
      } catch {
        return null;
      }
      // The offer ID comes from the admin console's URL: never address an unconfigured shard.
      if (!(await isConfiguredShard(env, input.tenantId, store.resolution))) return null;
      const stub = store.stub as unknown as CredentialOfferStoreRpcStub;
      const progress = await stub.getAdminOfferProgressRpc({
        id: input.offerId,
        tenantId: input.tenantId,
        userId: adminUserId,
        now: Date.now(),
      });
      return progress
        ? {
            offerId: progress.offerId,
            state: progress.state,
            expiresAt: progress.expiresAt,
            ...(progress.holderKeyThumbprint
              ? { holderKeyThumbprint: progress.holderKeyThumbprint }
              : {}),
          }
        : null;
    });
  }
}

export const SAML_DR_WRITER_SURFACES = [
  'rpc:VCIssuerEntrypoint.consumeAdminPresentation',
  'rpc:VCIssuerEntrypoint.createAdminCredentialOffer',
  'rpc:VCIssuerEntrypoint.createAdminPresentationRequest',
  'rpc:VCIssuerEntrypoint.createCredentialOffer',
  'rpc:VCIssuerEntrypoint.getAdminCredentialOfferStatus',
  'rpc:VCIssuerEntrypoint.getAdminPresentationStatus',
] as const;
