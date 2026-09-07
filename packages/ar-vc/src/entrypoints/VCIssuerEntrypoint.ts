import { WorkerEntrypoint } from 'cloudflare:workers';
import type {
  CreateCredentialOfferServiceInput,
  CreateCredentialOfferServiceResult,
} from '@authrim/ar-lib-core';
import { isValidTenantIdentifier } from '@authrim/ar-lib-core';
import type { Env } from '../types';
import type { CreateCredentialOfferInput } from '../issuer/durable-objects/CredentialOfferStore';
import {
  generatePreAuthorizedCode,
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

type CredentialOfferStoreRpcStub = {
  createOfferRpc(input: CreateCredentialOfferInput): Promise<unknown>;
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

/** RPC-only facade. It is not mounted on ar-vc's public Hono routes. */
export class VCIssuerEntrypoint extends WorkerEntrypoint<Env> {
  async createCredentialOffer(
    input: CreateCredentialOfferServiceInput
  ): Promise<CreateCredentialOfferServiceResult> {
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
    if (!(await verifyProfileContract(this.env, input, validated.manifest))) {
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
      this.env,
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
            this.env.VC_TRANSACTION_CODE_HMAC_SECRET,
            input.tenantId,
            offerId,
            transactionCode
          )
        : undefined,
      createdAt,
      expiresAt,
    });

    return {
      offerId,
      credentialOfferUri: `${credentialIssuer}/vci/offers/${encodeURIComponent(preAuthorizedCode)}`,
      expiresAt,
      claimManifestHash,
      ...(transactionCode ? { transactionCode } : {}),
    };
  }
}
