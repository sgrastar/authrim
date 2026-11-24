import { MAPPING_HASH_SECRET_REF } from '../services/mapping-hash-ref';
import {
  IDENTIFIER_SALT_FINGERPRINT_KEY_REF,
  IDENTIFIER_VALUE_HMAC_KEY_REF,
  IMPORTED_IDENTIFIER_SALT_PREFIX,
} from '../services/identifier-salt-refs';
import { runSamlDrCoveredOperation } from '../services/tenant-portability/saml-dr-writer';
/**
 * KeyManager Durable Object
 *
 * Manages RSA key pairs for JWT signing with support for key rotation.
 * Implements a key rotation strategy that maintains multiple active keys
 * to ensure zero-downtime key rotation.
 *
 * Key Rotation Strategy:
 * 1. New key is generated with a new kid (key ID)
 * 2. New key is added to the key set alongside existing keys
 * 3. New tokens are signed with the new key
 * 4. Old keys remain active for verification until rotation window expires
 * 5. Expired keys are removed from the key set
 *
 * This ensures that tokens signed with old keys can still be verified
 * during the transition period.
 */

import { DurableObject } from 'cloudflare:workers';
import { importPKCS8, SignJWT, type JWK, type JWTPayload } from 'jose';
import { generateKeySet } from '../utils/keys';
import { generateECKeySet, type ECAlgorithm, type ECCurve } from '../utils/ec-keys';
import type { OIDCSigningAlgorithm } from '../utils/oidc-signing';
import { timingSafeEqual } from '../utils/crypto';
import type { Env } from '../types/env';
import type { KeyStatus } from '../types/admin';
import { readRequestJsonWithLimit } from '../utils/body-limits';
import { createLogger } from '../utils/logger';
import { base64ToBytes, parseCertificate, validateVcSigningChain } from '../vc/x509-certificate';
import {
  keyManagerTenantBackupSnapshotIsEmpty,
  keyManagerTenantBackupSnapshotsEqual,
  normalizeKeyManagerTenantBackupSnapshot,
  type KeyManagerTenantBackupSnapshot,
} from '../services/tenant-portability/key-manager-portability';

const log = createLogger().module('DO-KEY-MANAGER');
const MAX_KEY_MANAGER_JSON_BODY_BYTES = 64 * 1024;
const TENANT_BACKUP_SNAPSHOT_KEY_PREFIX = 'tenantBackupSnapshot:';
const TENANT_BACKUP_SNAPSHOT_ID = /^[a-f0-9]{64}$/u;
const SECRET_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const FORBIDDEN_SECRET_REFS = new Set(['__proto__', 'constructor', 'prototype']);

class InvalidSecretRefError extends Error {
  constructor() {
    super('Invalid secret reference');
    this.name = 'InvalidSecretRefError';
  }
}

function validateSecretRef(secretRef: string): void {
  if (!SECRET_REF_PATTERN.test(secretRef) || FORBIDDEN_SECRET_REFS.has(secretRef)) {
    throw new InvalidSecretRefError();
  }
}

/**
 * The refs the private create / rotate paths (RPC and internal HTTP) never take: imported salts
 * are written only by `importSecretRpc` (a made-up secret must not stand in for one), and the
 * salt fingerprint key only by the import path itself.
 */
function validatePublicSecretRef(secretRef: string): void {
  validateSecretRef(secretRef);
  if (
    secretRef.startsWith(IMPORTED_IDENTIFIER_SALT_PREFIX) ||
    secretRef === IDENTIFIER_SALT_FINGERPRINT_KEY_REF ||
    secretRef === MAPPING_HASH_SECRET_REF ||
    secretRef === IDENTIFIER_VALUE_HMAC_KEY_REF
  ) {
    throw new InvalidSecretRefError();
  }
}

/**
 * Stored key metadata (RSA)
 */
interface StoredKey {
  kid: string;
  publicJWK: JWK;
  privatePEM: string;
  createdAt: number;
  status: KeyStatus; // 'active' | 'overlap' | 'revoked'
  certificatePEM?: string; // Public X.509 certificate used by protocols such as SAML metadata
  certificateCreatedAt?: number;
  certificateSha256Thumbprint?: string;
  expiresAt?: number; // When the key expires (for overlap keys)
  revokedAt?: number; // When the key was revoked (for revoked keys)
  revokedReason?: string; // Reason for revocation (for revoked keys)
}

interface StoreCertificateRequest {
  kid: string;
  certificatePEM: string;
  certificateCreatedAt?: number;
  certificateSha256Thumbprint?: string;
}

interface ImportKeyRequest {
  kid: string;
  publicJWK: JWK;
  privatePEM: string;
  createdAt?: number;
  status?: KeyStatus;
  certificatePEM?: string;
  certificateCreatedAt?: number;
  certificateSha256Thumbprint?: string;
}

/**
 * Stored EC key metadata
 * Used for SD-JWT VC signing (Phase 9)
 */
interface StoredECKey {
  kid: string;
  algorithm: ECAlgorithm;
  curve: ECCurve;
  publicJWK: JWK;
  privatePEM: string;
  createdAt: number;
  status: KeyStatus;
  expiresAt?: number;
  revokedAt?: number;
  revokedReason?: string;
  /**
   * VC signing keys only: the certificate chain for this key as base64 DER entries, leaf first,
   * trust anchor excluded (the `x5c` header value). Set by `setVcIssuerKeyCertificateChainRpc`
   * after the chain has been validated against this key.
   */
  certificateChain?: string[];
  /** The earliest `notAfter` of any certificate in `certificateChain`, epoch milliseconds. */
  certificateNotAfter?: number;
  /** The issuer host the leaf was validated for; `x5c` is sent only for credentials of this host. */
  certificateIssuerHost?: string;
  /**
   * SHA-256 (lower-case hex) of the issuing CA certificate that ended the chain when it was
   * registered. `x5c` is sent only while this CA is still in the configured allowlist.
   */
  certificateCaSha256?: string;
}

/**
 * The UTF-8 size of a value's JSON text, or null when it cannot be serialised (a cycle, a BigInt,
 * undefined). The signing libraries measure and sign bytes, so limits are in bytes, not code units.
 */
function jsonByteLength(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? new TextEncoder().encode(text).byteLength : null;
  } catch {
    return null;
  }
}

/** A JWT claims object: a plain, non-null object whose time claims, if present, are finite. */
function isSignablePayload(payload: unknown): payload is JWTPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const claims = payload as Record<string, unknown>;
  return ['iat', 'exp', 'nbf'].every(
    (name) =>
      claims[name] === undefined ||
      (typeof claims[name] === 'number' && Number.isFinite(claims[name]))
  );
}

/**
 * The active VC ES256 key, created on first use. The retention cap is an expected refusal (it is
 * raised before anything is written), returned as null; any other failure, a failed save
 * included, propagates.
 */
async function ensureVcKeyOrRefusal(
  ensure: () => Promise<StoredECKey>
): Promise<StoredECKey | null> {
  try {
    return await ensure();
  } catch (error) {
    if (error instanceof Error && error.message === 'vc_issuer_key_retention_cap_reached') {
      return null;
    }
    throw error;
  }
}

/** An expected refusal returned out of a write-permit scope instead of thrown (see the RPCs). */
interface Refusal {
  refused: string;
}

/** What the certificate issuer needs to know about the active VC signing key. */
export interface VcSigningCertificateState {
  kid: string;
  /** The public key to certify (no private member). */
  publicJWK: JWK;
  /** The host the stored chain was validated for, or null when the key has no chain. */
  issuerHost: string | null;
  /** SHA-256 (lower-case hex) of the issuing CA that ended the stored chain, or null. */
  caSha256: string | null;
  /** The earliest `notAfter` of the stored chain (epoch milliseconds), or null. */
  chainNotAfter: number | null;
}

/** Options of the two VC signing RPCs. */
export interface VcSigningOptions {
  /**
   * Fail the signing instead of falling back to a header without `x5c`. HAIP flows set this: a
   * credential without the issuer certificate chain is not a HAIP credential.
   */
  requireX5c?: boolean;
}

/** The options of a VC signing RPC, or null when they are not a plain `{ requireX5c?: boolean }`. */
function parseVcSigningOptions(options: unknown): VcSigningOptions | null {
  if (options === undefined) return { requireX5c: false };
  if (
    typeof options !== 'object' ||
    options === null ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options) as object | null) ||
    Object.keys(options).some((key) => key !== 'requireX5c') ||
    (Object.hasOwn(options, 'requireX5c') &&
      typeof (options as VcSigningOptions).requireX5c !== 'boolean')
  ) {
    return null;
  }
  return {
    requireX5c:
      Object.hasOwn(options, 'requireX5c') && (options as VcSigningOptions).requireX5c === true,
  };
}

/** The configured Authrim issuing CA fingerprints: lower-case hex SHA-256, comma separated. */
function trustedIssuingCaFingerprints(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => /^[0-9a-f]{64}$/u.test(entry));
}

export interface SetVcIssuerKeyCertificateChainInput {
  kid: string;
  /** Base64 DER certificates, leaf first, trust anchor excluded. */
  chain: string[];
  /** The credential issuer host the leaf must name. */
  issuerHost: string;
}

/**
 * Certificate chains are not part of a tenant backup: a chain ties a key to the Authrim CA and to
 * the tenant's issuer host at one point in time, and a restored key gets a new chain from the CA
 * service. Backup export, verification and comparison all see the state without them.
 */
function withoutVcCertificateChains(
  snapshot: KeyManagerTenantBackupSnapshot
): KeyManagerTenantBackupSnapshot {
  for (const key of snapshot.vcEc.keys as Partial<StoredECKey>[]) {
    delete key.certificateChain;
    delete key.certificateNotAfter;
    delete key.certificateIssuerHost;
    delete key.certificateCaSha256;
  }
  return snapshot;
}

/** The host of a credential issuer identifier: an https URL or `did:web:<host>`. */
function issuerHostOf(issuer: unknown): string | null {
  if (typeof issuer !== 'string') return null;
  if (issuer.startsWith('did:web:')) {
    const host = issuer.slice('did:web:'.length);
    return /^[a-z0-9.-]{1,253}$/u.test(host) ? host : null;
  }
  try {
    const url = new URL(issuer);
    return url.protocol === 'https:' ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * The `x5c` protected-header member for a VC signing key, or undefined when it must not be sent.
 * The chain is sent only while every certificate in it is valid, while its issuing CA is still
 * trusted, for a token whose `iss` is on the host the leaf was validated for, and only for a token
 * with a finite `exp` that the chain outlives (a verifier checking the chain later must still find
 * it valid). Otherwise a token falls back to key resolution through the published JWKS, as before
 * certificates existed, unless the caller required `x5c`.
 */
function x5cHeader(
  key: StoredECKey,
  now: number,
  payload: JWTPayload,
  trustedCas: string[]
): { x5c: string[] } | undefined {
  const host = issuerHostOf(payload.iss);
  if (
    !key.certificateChain ||
    key.certificateChain.length === 0 ||
    typeof key.certificateNotAfter !== 'number' ||
    key.certificateNotAfter <= now ||
    !key.certificateIssuerHost ||
    host !== key.certificateIssuerHost ||
    !key.certificateCaSha256 ||
    !trustedCas.includes(key.certificateCaSha256)
  ) {
    return undefined;
  }
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return undefined;
  if (payload.exp * 1000 > key.certificateNotAfter) return undefined;
  return { x5c: key.certificateChain };
}

export interface SignVCIAccessTokenInput {
  tenantId: string;
  userId: string;
  offerId: string;
  credentialConfigurationId: string;
  /** Authorization Server identifier (`iss`). */
  issuer: string;
  /** Credential Issuer identifier (`aud`). */
  audience: string;
  expiresInSeconds?: number;
}

export interface SignVCIAccessTokenResult {
  token: string;
  kid: string;
  jti: string;
}

export interface SignSDJWTIssuerResult {
  token: string;
  kid: string;
}

export const HAIP_LOGIN_CLIENT_ID_PREFIX = 'x509_hash:';
const X509_HASH_VALUE = /^[A-Za-z0-9_-]{43}$/u;

function base64UrlOf(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/** `x509_hash:` and the base64url SHA-256 of the DER of the chain's leaf certificate. */
async function x509HashClientIdOf(chain: string[]): Promise<string> {
  const leaf = base64ToBytes(chain[0]);
  return `${HAIP_LOGIN_CLIENT_ID_PREFIX}${base64UrlOf(new Uint8Array(await crypto.subtle.digest('SHA-256', leaf)))}`;
}

const HAIP_LOGIN_RESPONSE_PATH = '/vp/login/response';
const HAIP_LOGIN_PAYLOAD_KEYS = new Set([
  'aud',
  'client_id',
  'response_type',
  'response_mode',
  'response_uri',
  'nonce',
  'state',
  'iat',
  'exp',
  'client_metadata',
  'dcql_query',
]);
const HAIP_LOGIN_METADATA_KEYS = new Set([
  'jwks',
  'encrypted_response_enc_values_supported',
  'vp_formats_supported',
]);

/** One `dc+sd-jwt` credential query for one VCT, optionally limited to authority key identifiers. */
function isHaipLoginDcqlQuery(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const query = value as { credentials?: unknown };
  if (Object.keys(value).length !== 1 || !Array.isArray(query.credentials)) return false;
  if (query.credentials.length !== 1) return false;
  const credential = query.credentials[0] as Record<string, unknown> | null;
  if (typeof credential !== 'object' || credential === null) return false;
  const allowed = new Set(['id', 'format', 'meta', 'claims', 'trusted_authorities']);
  if (!Object.keys(credential).every((key) => allowed.has(key))) return false;
  const meta = credential.meta as { vct_values?: unknown } | undefined;
  const authorities = credential.trusted_authorities;
  return (
    typeof credential.id === 'string' &&
    credential.format === 'dc+sd-jwt' &&
    Array.isArray(meta?.vct_values) &&
    meta.vct_values.length === 1 &&
    typeof meta.vct_values[0] === 'string' &&
    (authorities === undefined ||
      (Array.isArray(authorities) &&
        authorities.length === 1 &&
        (authorities[0] as { type?: unknown }).type === 'aki'))
  );
}

/**
 * Whether `payload` is the one shape of a HAIP login request object KeyManager signs: a fresh,
 * short-lived OpenID4VP request for a `vp_token` answered encrypted (`direct_post.jwt`) to an
 * https `response_uri`, naming the verifier by `x509_hash`, with one ephemeral P-256 encryption
 * key that carries a `kid`. Returns the response host and the hash named as the client id.
 */
export function haipLoginRequestShape(
  payload: JWTPayload,
  now: number
): { clientHash: string; responseHost: string } | null {
  const clientId = typeof payload.client_id === 'string' ? payload.client_id : '';
  if (!clientId.startsWith(HAIP_LOGIN_CLIENT_ID_PREFIX)) return null;
  const clientHash = clientId.slice(HAIP_LOGIN_CLIENT_ID_PREFIX.length);
  if (!X509_HASH_VALUE.test(clientHash)) return null;
  const iat = payload.iat;
  const exp = payload.exp;
  let responseUri: URL;
  try {
    responseUri = new URL(String(payload.response_uri));
  } catch {
    return null;
  }
  const metadata = payload.client_metadata as
    | { jwks?: { keys?: Array<Record<string, unknown>> } }
    | undefined;
  const keys = metadata?.jwks?.keys;
  const valid =
    payload.aud === 'https://self-issued.me/v2' &&
    payload.response_type === 'vp_token' &&
    payload.response_mode === 'direct_post.jwt' &&
    responseUri.protocol === 'https:' &&
    responseUri.port === '' &&
    typeof payload.nonce === 'string' &&
    payload.nonce.length >= 16 &&
    payload.nonce.length <= 128 &&
    typeof payload.state === 'string' &&
    payload.state.length >= 16 &&
    payload.state.length <= 128 &&
    typeof iat === 'number' &&
    Math.abs(iat - now) <= 300 &&
    typeof exp === 'number' &&
    exp > iat &&
    exp - iat <= 600 &&
    responseUri.pathname === HAIP_LOGIN_RESPONSE_PATH &&
    responseUri.search === '' &&
    responseUri.hash === '' &&
    responseUri.username === '' &&
    responseUri.password === '' &&
    Object.keys(payload).every((key) => HAIP_LOGIN_PAYLOAD_KEYS.has(key)) &&
    Object.keys(metadata ?? {}).every((key) => HAIP_LOGIN_METADATA_KEYS.has(key)) &&
    isHaipLoginDcqlQuery(payload.dcql_query) &&
    Array.isArray(keys) &&
    keys.length === 1 &&
    keys[0].kty === 'EC' &&
    keys[0].crv === 'P-256' &&
    typeof keys[0].x === 'string' &&
    typeof keys[0].y === 'string' &&
    typeof keys[0].kid === 'string' &&
    keys[0].kid.length > 0 &&
    !('d' in keys[0]) &&
    JSON.stringify(payload).length <= 16 * 1024;
  return valid ? { clientHash, responseHost: responseUri.hostname } : null;
}

const ADMIN_VP_CLIENT_ID_PREFIX = 'decentralized_identifier:';
const DID_WEB_HOST = /^did:web:[a-z0-9.-]{1,253}$/u;

/**
 * The did:web DID of an administrator presentation request, or null when the payload is not the
 * one shape KeyManager signs for it: a fresh, short-lived OpenID4VP request for a `vp_token`
 * posted back to an https `response_uri` on the DID's own host.
 */
export function adminVPRequestDid(payload: JWTPayload, now: number): string | null {
  const clientId = typeof payload.client_id === 'string' ? payload.client_id : '';
  if (!clientId.startsWith(ADMIN_VP_CLIENT_ID_PREFIX)) return null;
  const did = clientId.slice(ADMIN_VP_CLIENT_ID_PREFIX.length);
  if (!DID_WEB_HOST.test(did)) return null;
  const iat = payload.iat;
  const exp = payload.exp;
  const transactionData = payload.transaction_data;
  const common =
    payload.response_type === 'vp_token' &&
    typeof payload.nonce === 'string' &&
    payload.nonce.length >= 16 &&
    payload.nonce.length <= 128 &&
    typeof iat === 'number' &&
    Math.abs(iat - now) <= 300 &&
    typeof exp === 'number' &&
    exp > iat &&
    exp - iat <= 600 &&
    typeof payload.dcql_query === 'object' &&
    payload.dcql_query !== null &&
    Array.isArray(transactionData) &&
    transactionData.length === 1 &&
    typeof transactionData[0] === 'string' &&
    transactionData[0].length <= 4096 &&
    JSON.stringify(payload).length <= 16 * 1024;
  if (!common) return null;

  if (payload.response_mode === 'direct_post') {
    // Cross-device: posted back to the DID's own host.
    let responseUri: URL;
    try {
      responseUri = new URL(String(payload.response_uri));
    } catch {
      return null;
    }
    const valid =
      responseUri.protocol === 'https:' &&
      responseUri.hostname === did.slice('did:web:'.length) &&
      responseUri.port === '' &&
      typeof payload.state === 'string' &&
      payload.state.length > 0 &&
      payload.state.length <= 256;
    return valid ? did : null;
  }

  if (payload.response_mode === 'dc_api.jwt') {
    // Digital Credentials API (OpenID4VP 1.0 Appendix A): the browser hands the request to the
    // wallet only for the one origin named here, and the answer comes back encrypted to the
    // single ephemeral key of client_metadata.
    const origins = payload.expected_origins;
    const metadata = payload.client_metadata as
      | { jwks?: { keys?: unknown }; encrypted_response_enc_values_supported?: unknown }
      | undefined;
    const keys = metadata?.jwks?.keys;
    if (
      !Array.isArray(origins) ||
      origins.length !== 1 ||
      typeof origins[0] !== 'string' ||
      !isHttpsOrigin(origins[0]) ||
      'response_uri' in payload ||
      !Array.isArray(keys) ||
      keys.length !== 1 ||
      !isEncryptionPublicKey(keys[0])
    ) {
      return null;
    }
    return did;
  }
  return null;
}

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

function isEncryptionPublicKey(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const jwk = value as Record<string, unknown>;
  return (
    jwk.kty === 'EC' &&
    jwk.crv === 'P-256' &&
    typeof jwk.x === 'string' &&
    typeof jwk.y === 'string' &&
    !('d' in jwk) &&
    jwk.use === 'enc' &&
    jwk.alg === 'ECDH-ES'
  );
}

export interface SignStatusListCredentialResult {
  token: string;
  kid: string;
}

/** Salts imported from other identity providers a tenant may keep. */
const MAX_IMPORTED_SALTS = 32;
/** What a portable key manager state carries at most (key-manager-portability MAX_SECRETS). */
const MAX_PORTABLE_SECRETS = 256;

/** The bytes of a base64 (or base64url) secret value; null when it is not base64. */
function decodeSecretBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * A short, stable fingerprint of an imported salt: the first 16 hex characters of HMAC-SHA-256
 * over the salt's bytes, keyed with this key manager's own fingerprint key. A bare hash would let
 * a weak salt be guessed offline from a fingerprint seen in the list or the audit log.
 */
async function saltFingerprint(keyValue: string, saltBase64: string): Promise<string> {
  // The importer sends base64; anything else is taken as the text it is.
  const salt = decodeSecretBytes(saltBase64) ?? new TextEncoder().encode(saltBase64);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(keyValue),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, salt));
  return Array.from(mac.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readFingerprintKey(secrets: Record<string, StoredSecret>): StoredSecret | undefined {
  return Object.getOwnPropertyDescriptor(secrets, IDENTIFIER_SALT_FINGERPRINT_KEY_REF)?.value as
    | StoredSecret
    | undefined;
}

interface StoredSecretVersion {
  kid: string;
  value: string;
  createdAt: number;
}

interface StoredSecret {
  secretRef: string;
  active: StoredSecretVersion;
  previous?: StoredSecretVersion;
  updatedAt: number;
}

/**
 * Key rotation configuration
 */
interface KeyRotationConfig {
  rotationIntervalDays: number;
  retentionPeriodDays: number;
}

/**
 * KeyManager Durable Object State
 */
interface KeyManagerState {
  keys: StoredKey[];
  activeKeyId: string | null;
  config: KeyRotationConfig;
  lastRotation: number | null;
  secrets?: Record<string, StoredSecret>;
}

/**
 * EC Key Manager State (Phase 9)
 * Separate state for EC keys used in VC signing
 */
interface ECKeyManagerState {
  keys: StoredECKey[];
  activeKeyIds: Record<ECAlgorithm, string | null>;
  config: KeyRotationConfig;
  lastRotation: number | null;
  /** Public halves of normally retired keys. Verify-only; absent in state stored before retention. */
  retiredPublicKeys?: RetiredECPublicKey[];
}

/**
 * Public key of an EC key retired by normal rotation. The private key is gone, so it can never
 * sign; it is kept so long-lived credentials signed with it still verify until retainUntil.
 */
interface RetiredECPublicKey {
  kid: string;
  algorithm: ECAlgorithm;
  publicJWK: JWK;
  retiredAt: number;
  retainUntil: number;
}

/** How long a normally retired EC public key stays resolvable (max credential lifetime). */
const RETIRED_EC_PUBLIC_KEY_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
/**
 * Upper bound on retained public keys (same cap as DR backup). Rotation is refused before it is
 * reached, so an unexpired retained key is never dropped.
 */
const MAX_RETIRED_EC_PUBLIC_KEYS = 1024;

/** Longest stored `revokedReason`, in UTF-8 bytes (DR backup accepts at most 2048). */
export const MAX_KEY_REVOCATION_REASON_BYTES = 2048;

/** Dedicated EC state for OIDC ID Token and UserInfo signing. Never shared with VC keys. */
interface OIDCECKeyManagerState {
  keys: StoredECKey[];
  activeKeyId: string | null;
  config: KeyRotationConfig;
  lastRotation: number | null;
}

/** Dedicated RSA-PSS state for OIDC PS256 signing. Never shared with RS256 keys. */
interface OIDCPS256KeyManagerState {
  keys: StoredKey[];
  activeKeyId: string | null;
  config: KeyRotationConfig;
  lastRotation: number | null;
}

/**
 * Dedicated RSA state for the keys apps encrypt request objects to (RSA-OAEP-256, use enc).
 * Never shared with a signing key.
 */
type RequestObjectEncKeyManagerState = OIDCPS256KeyManagerState;

/** The key management algorithm of the request object encryption keys. */
export const REQUEST_OBJECT_ENCRYPTION_KEY_ALG = 'RSA-OAEP-256';

/** An encryption key apps may still encrypt to: not revoked, and not past its overlap. */
function isUsableRequestObjectEncKey(key: StoredKey, now: number): boolean {
  return key.status !== 'revoked' && (key.expiresAt === undefined || key.expiresAt > now);
}

function normalizeImportedKeyStatus(status: unknown): KeyStatus {
  return status === 'overlap' || status === 'revoked' ? status : 'active';
}

function normalizeTimestamp(value: unknown, fallback: number): number;
function normalizeTimestamp(value: unknown, fallback: number | undefined): number | undefined;
function normalizeTimestamp(value: unknown, fallback: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isImportablePublicJWK(value: unknown): value is JWK {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const jwk = value as JWK;
  return jwk.kty === 'RSA' && typeof jwk.n === 'string' && typeof jwk.e === 'string';
}

function isImportablePrivatePEM(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 32 * 1024 &&
    value.startsWith('-----BEGIN PRIVATE KEY-----') &&
    value.includes('-----END PRIVATE KEY-----')
  );
}

function isImportableCertificatePEM(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 16 * 1024 &&
    value.startsWith('-----BEGIN CERTIFICATE-----') &&
    value.includes('-----END CERTIFICATE-----')
  );
}

async function verifyImportedKeyPair(
  kid: string,
  publicJWK: JWK,
  privatePEM: string
): Promise<JWK> {
  try {
    const privateKey = await importPKCS8(privatePEM, 'RS256');
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      publicJWK as JsonWebKey,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const verificationInput = new TextEncoder().encode('authrim-key-manager-import-check');
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, verificationInput);
    const verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      signature,
      verificationInput
    );
    if (!verified) {
      throw new Error('Imported public JWK does not match private PEM');
    }
    return {
      ...publicJWK,
      kty: 'RSA',
      kid,
      use: 'sig',
      alg: 'RS256',
    };
  } catch {
    throw new Error('Imported public JWK does not match private PEM');
  }
}

/**
 * The checks `importKey` makes on a key before storing it, without touching any state: the kid,
 * the public JWK, the private PEM and certificate shapes, and that the two halves are one pair.
 * Lets a restore validate every key before it changes anything (or spends a step-up receipt).
 * @returns The public JWK as `importKey` would store it
 */
export async function assertImportableSigningKey(input: {
  kid: unknown;
  publicJWK: unknown;
  privatePEM: unknown;
  certificatePEM?: unknown;
}): Promise<JWK> {
  const kid = typeof input.kid === 'string' ? input.kid.trim() : '';
  if (!kid || kid.length > 256 || /[\u0000-\u001f\u007f]/.test(kid)) {
    throw new Error('Invalid key ID');
  }
  if (!isImportablePublicJWK(input.publicJWK)) {
    throw new Error('Invalid public JWK');
  }
  if (!isImportablePrivatePEM(input.privatePEM)) {
    throw new Error('Invalid private PEM');
  }
  if (input.certificatePEM && !isImportableCertificatePEM(input.certificatePEM)) {
    throw new Error('Invalid certificate PEM');
  }
  return verifyImportedKeyPair(kid, input.publicJWK, input.privatePEM);
}

/**
 * KeyManager Durable Object
 *
 * Manages cryptographic keys for JWT signing with automatic rotation support.
 * Supports both RSA keys (for OIDC tokens) and EC keys (for SD-JWT VC in Phase 9).
 *
 * RPC Support:
 * - Extends DurableObject base class for RPC method exposure
 * - RPC methods have 'Rpc' suffix (e.g., getActiveKeyRpc, rotateKeysRpc)
 * - fetch() handler is maintained for backward compatibility and debugging
 *
 * Key Types:
 * - RSA: RS256 for OIDC ID tokens and access tokens
 * - EC: ES256/ES384/ES512 for SD-JWT VC (HAIP compliance)
 */
/** Complete public source admission surface; checked against the class prototype in tests. */
export const SAML_DR_KEY_MANAGER_SURFACE = {
  guarded: [
    'getActiveKeyRpc',
    'getActiveKeyWithPrivateRpc',
    'getAllPublicKeysRpc',
    'getActiveOIDCSigningKeyWithPrivateRpc',
    'getAllOIDCPublicKeysRpc',
    'getRequestObjectDecryptionKeyRpc',
    'rotateRequestObjectEncKeyRpc',
    'rotateOIDCES256KeyRpc',
    'rotateOIDCPS256KeyRpc',
    'rotateKeysRpc',
    'rotateKeysWithPrivateRpc',
    'emergencyRotateKeysRpc',
    'shouldRotateKeysRpc',
    'getConfigRpc',
    'updateConfigRpc',
    'getStatusRpc',
    'importTenantBackupStateRpc',
    'getActiveECKeyRpc',
    'getActiveECKeyWithPrivateRpc',
    'signVCIAccessTokenRpc',
    'signSDJWTIssuerRpc',
    'signStatusListCredentialRpc',
    'signAdminVPRequestRpc',
    'signHaipLoginRequestRpc',
    'getHaipLoginVerifierRpc',
    'getAllECPublicKeysRpc',
    'getVcIssuerJwksRpc',
    'revokeVcIssuerKeyRpc',
    'setVcIssuerKeyCertificateChainRpc',
    'getVcSigningCertificateStateRpc',
    'rotateECKeysRpc',
    'rotateECKeysWithPrivateRpc',
    'emergencyRotateECKeysRpc',
    'getECStatusRpc',
    'generateNewKey',
    'setActiveKey',
    'getActiveKey',
    'getAllPublicKeys',
    'getKey',
    'rotateKeys',
    'emergencyRotateKeys',
    'shouldRotateKeys',
    'updateConfig',
    'getConfig',
    'provisionMappingHashKeyRpc',
    'rotateMappingHashKeyRpc',
    'getOrCreateSecretRpc',
    'rotateSecretRpc',
    'importSecretRpc',
    'identifierValueHmacsRpc',
    'storeCertificateForKey',
    'importKey',
    'generateNewECKey',
    'setActiveECKey',
    'getActiveECKey',
    'getAllECPublicKeys',
    'rotateECKeys',
    'emergencyRotateECKeys',
    'fetch',
  ],
  snapshot: [
    'startTenantBackupSnapshotRpc',
    'loadTenantBackupSnapshotRpc',
    'releaseTenantBackupSnapshotRpc',
    'assertTenantBackupSnapshotReleasedRpc',
  ],
  readonly: [
    'exportTenantBackupStateRpc',
    'verifyTenantBackupStateRpc',
    'getExistingSecretRpc',
    'listImportedSecretsRpc',
  ],
} as const;

const TOKEN_STATUS_LIST_CLAIMS = new Set(['iss', 'sub', 'iat', 'exp', 'ttl', 'status_list']);
const MAX_STATUS_LIST_TTL_SECONDS = 86400;

function sameHttpsOrigin(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return (
      left.protocol === 'https:' && right.protocol === 'https:' && left.origin === right.origin
    );
  } catch {
    return false;
  }
}

/** Token Status List (draft-14): https issuer, `sub` the list URI on the issuer's origin */
function isValidTokenStatusListPayload(payload: JWTPayload, now: number): boolean {
  const statusList = payload.status_list as { bits?: unknown; lst?: unknown } | undefined;
  return (
    Object.keys(payload).every((claim) => TOKEN_STATUS_LIST_CLAIMS.has(claim)) &&
    typeof payload.iss === 'string' &&
    typeof payload.sub === 'string' &&
    sameHttpsOrigin(payload.iss, payload.sub) &&
    typeof payload.iat === 'number' &&
    payload.iat <= now + 60 &&
    payload.iat >= now - 600 &&
    typeof payload.exp === 'number' &&
    payload.exp > now &&
    payload.exp <= now + 86400 &&
    typeof payload.ttl === 'number' &&
    Number.isInteger(payload.ttl) &&
    payload.ttl > 0 &&
    payload.ttl <= MAX_STATUS_LIST_TTL_SECONDS &&
    typeof statusList === 'object' &&
    statusList !== null &&
    [1, 2, 4, 8].includes(statusList.bits as number) &&
    typeof statusList.lst === 'string'
  );
}

/** Legacy Bitstring Status List JWT (did:web issuer, `vc` credential) */
function isValidLegacyStatusListPayload(payload: JWTPayload, now: number): boolean {
  const vc = payload.vc as
    | {
        type?: unknown;
        credentialSubject?: { type?: unknown; statusPurpose?: unknown; encodedList?: unknown };
      }
    | undefined;
  const subject = vc?.credentialSubject;
  return (
    typeof payload.iss === 'string' &&
    payload.iss.startsWith('did:web:') &&
    typeof payload.sub === 'string' &&
    payload.sub.startsWith('https://') &&
    typeof payload.iat === 'number' &&
    Math.abs(payload.iat - now) <= 300 &&
    typeof payload.exp === 'number' &&
    payload.exp > now &&
    payload.exp <= now + 86400 &&
    Array.isArray(vc?.type) &&
    vc.type.includes('BitstringStatusListCredential') &&
    subject?.type === 'BitstringStatusList' &&
    typeof subject.statusPurpose === 'string' &&
    ['revocation', 'suspension'].includes(subject.statusPurpose) &&
    typeof subject.encodedList === 'string'
  );
}

export class KeyManager extends DurableObject<Env> {
  private keyManagerState: KeyManagerState | null = null;
  private ecKeyManagerState: ECKeyManagerState | null = null;
  private oidcECKeyManagerState: OIDCECKeyManagerState | null = null;
  private oidcPS256KeyManagerState: OIDCPS256KeyManagerState | null = null;
  private oidcES256CreationPromise: Promise<StoredECKey> | null = null;
  private oidcPS256CreationPromise: Promise<StoredKey> | null = null;
  private vcES256CreationPromise: Promise<StoredECKey> | null = null;
  private requestObjectEncKeyManagerState: RequestObjectEncKeyManagerState | null = null;
  private requestObjectEncCreationPromise: Promise<StoredKey> | null = null;
  #requiresAdmittedInitialization = false;
  #admittedInitialization: Promise<void> | null = null;
  #reloadBeforeOperation = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Block all requests until initialization completes
    // This ensures the DO is in a consistent state before processing any requests
    // Critical for cryptographic key management and migration
    this.initialization = ctx.blockConcurrencyWhile(async () => {
      if (env.ENABLE_SAML_DR_EXPORT === 'true') {
        await this.#loadExistingState();
      } else {
        await this.#initializeStateBlocking();
      }
    });
  }

  /** The initialization the constructor started; a call made before it ends waits for it. */
  private readonly initialization: Promise<void>;

  /** Loading an opted-in source cannot create or migrate authority before admission. */
  async #loadExistingState(): Promise<void> {
    const [rsa, ec, oidcEC, oidcPS256, requestObjectEnc] = await Promise.all([
      this.ctx.storage.get<KeyManagerState>('state'),
      this.ctx.storage.get<ECKeyManagerState>('ecState'),
      this.ctx.storage.get<OIDCECKeyManagerState>('oidcECState'),
      this.ctx.storage.get<OIDCPS256KeyManagerState>('oidcPS256State'),
      this.ctx.storage.get<RequestObjectEncKeyManagerState>('requestObjectEncState'),
    ]);
    this.keyManagerState = rsa ?? null;
    this.ecKeyManagerState = ec ?? null;
    this.oidcECKeyManagerState = oidcEC ?? null;
    this.oidcPS256KeyManagerState = oidcPS256 ?? null;
    this.requestObjectEncKeyManagerState = requestObjectEnc ?? null;
    this.#requiresAdmittedInitialization =
      !rsa ||
      !ec ||
      !oidcEC ||
      !oidcPS256 ||
      !requestObjectEnc ||
      rsa.keys.some((key) => 'isActive' in key && !('status' in key));
    this.#reloadBeforeOperation = false;
  }

  /** Snapshot work runs under the caller's held boundary, never an ordinary writer permit. */
  async #assertSnapshotAuthority(): Promise<void> {
    await this.initialization;
    if (this.env.ENABLE_SAML_DR_EXPORT === 'true') {
      if (this.#requiresAdmittedInitialization || !this.keyManagerState)
        throw new Error('saml_dr_key_manager_authority_uninitialized');
      return;
    }
    await this.#initializeState();
  }

  /**
   * Initialize state from Durable Storage
   * Called by blockConcurrencyWhile() in constructor
   */
  async #initializeStateBlocking(): Promise<void> {
    // Initialize RSA key state
    const stored = await this.ctx.storage.get<KeyManagerState>('state');

    if (stored) {
      this.keyManagerState = stored;
      this.keyManagerState.secrets ??= {};
      // Run migration if needed
      await this.#migrateIsActiveToStatus();
    } else {
      // Initialize with default configuration
      this.keyManagerState = {
        keys: [],
        activeKeyId: null,
        config: {
          rotationIntervalDays: 90,
          retentionPeriodDays: 30,
        },
        lastRotation: null,
        secrets: {},
      };

      await this.#saveState();
    }

    // Initialize EC key state (Phase 9)
    const storedECState = await this.ctx.storage.get<ECKeyManagerState>('ecState');

    if (storedECState) {
      this.ecKeyManagerState = storedECState;
    } else {
      // Initialize with default configuration for EC keys
      this.ecKeyManagerState = {
        keys: [],
        activeKeyIds: {
          ES256: null,
          ES384: null,
          ES512: null,
        },
        config: {
          rotationIntervalDays: 90,
          retentionPeriodDays: 30,
        },
        lastRotation: null,
      };

      await this.#saveECState();
    }

    const storedOIDCECState = await this.ctx.storage.get<OIDCECKeyManagerState>('oidcECState');
    if (storedOIDCECState) {
      this.oidcECKeyManagerState = storedOIDCECState;
    } else {
      this.oidcECKeyManagerState = {
        keys: [],
        activeKeyId: null,
        config: {
          rotationIntervalDays: 90,
          retentionPeriodDays: 30,
        },
        lastRotation: null,
      };
      await this.#saveOIDCECState();
    }

    const storedOIDCPS256State =
      await this.ctx.storage.get<OIDCPS256KeyManagerState>('oidcPS256State');
    if (storedOIDCPS256State) {
      this.oidcPS256KeyManagerState = storedOIDCPS256State;
    } else {
      this.oidcPS256KeyManagerState = {
        keys: [],
        activeKeyId: null,
        config: {
          rotationIntervalDays: 90,
          retentionPeriodDays: 30,
        },
        lastRotation: null,
      };
      await this.#saveOIDCPS256State();
    }

    const storedRequestObjectEncState =
      await this.ctx.storage.get<RequestObjectEncKeyManagerState>('requestObjectEncState');
    if (storedRequestObjectEncState) {
      this.requestObjectEncKeyManagerState = storedRequestObjectEncState;
    } else {
      this.requestObjectEncKeyManagerState = {
        keys: [],
        activeKeyId: null,
        config: {
          rotationIntervalDays: 90,
          retentionPeriodDays: 30,
        },
        lastRotation: null,
      };
      await this.#saveRequestObjectEncState();
    }
  }

  // ==========================================
  // RPC Methods (public, with 'Rpc' suffix)
  // ==========================================

  /**
   * RPC: Get the active signing key (without private key)
   */
  async getActiveKeyRpc(): Promise<Omit<StoredKey, 'privatePEM'> | null> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      const activeKey = await this.getActiveKey();
      if (!activeKey) return null;
      return this.#sanitizeKey(activeKey);
    });
  }

  /**
   * RPC: Get the active signing key with private key (for internal use)
   */
  async getActiveKeyWithPrivateRpc(): Promise<StoredKey | null> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      return this.getActiveKey();
    });
  }

  /**
   * RPC: Get all public keys (for JWKS endpoint)
   */
  async getAllPublicKeysRpc(): Promise<JWK[]> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      return this.getAllPublicKeys();
    });
  }

  /** RPC: Get or create the active key for an OIDC signing algorithm. */
  async getActiveOIDCSigningKeyWithPrivateRpc(
    algorithm: OIDCSigningAlgorithm
  ): Promise<StoredKey | StoredECKey> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      if (algorithm === 'RS256') {
        return (await this.getActiveKey()) ?? (await this.rotateKeys());
      }
      if (algorithm === 'ES256') {
        return this.#ensureActiveOIDCES256Key();
      }
      if (algorithm === 'PS256') {
        return this.#ensureActiveOIDCPS256Key();
      }
      throw new Error('unsupported_oidc_signing_algorithm');
    });
  }

  /** RPC: Public OIDC JWKS, including RSA and the purpose-separated OIDC ES256 key. */
  async getAllOIDCPublicKeysRpc(): Promise<JWK[]> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      if (!(await this.getActiveKey())) {
        await this.rotateKeys();
      }
      await this.#ensureActiveOIDCES256Key();
      await this.#ensureActiveOIDCPS256Key();
      await this.#ensureActiveRequestObjectEncKey();
      return [
        ...(await this.getAllPublicKeys()),
        ...this.#getAllOIDCECPublicKeys(),
        ...this.#getAllOIDCPS256PublicKeys(),
        ...this.#getAllRequestObjectEncPublicKeys(),
      ];
    });
  }

  /**
   * RPC: The private key to decrypt a request object with: the one its kid names (active or still
   * overlapping), else the active one. Null when the kid names none of them.
   */
  async getRequestObjectDecryptionKeyRpc(kid?: string): Promise<StoredKey | null> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      if (kid === undefined) return this.#ensureActiveRequestObjectEncKey();
      const now = Date.now();
      return (
        this.#getRequestObjectEncState().keys.find(
          (key) => key.kid === kid && isUsableRequestObjectEncKey(key, now)
        ) ?? null
      );
    });
  }

  /** RPC: Rotate only the request object encryption key. */
  async rotateRequestObjectEncKeyRpc(): Promise<Omit<StoredKey, 'privatePEM'>> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      return this.#sanitizeKey(await this.#rotateRequestObjectEncKey());
    });
  }

  /** RPC: Rotate only the purpose-separated OIDC ES256 key. */
  async rotateOIDCES256KeyRpc(): Promise<Omit<StoredECKey, 'privatePEM'>> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      return this.#sanitizeECKey(await this.#rotateOIDCES256Key());
    });
  }

  /** RPC: Rotate only the purpose-separated OIDC PS256 key. */
  async rotateOIDCPS256KeyRpc(): Promise<Omit<StoredKey, 'privatePEM'>> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      return this.#sanitizeKey(await this.#rotateOIDCPS256Key());
    });
  }

  /**
   * RPC: Rotate keys
   */
  async rotateKeysRpc(): Promise<Omit<StoredKey, 'privatePEM'>> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      const newKey = await this.rotateKeys();
      return this.#sanitizeKey(newKey);
    });
  }

  /**
   * RPC: Rotate keys (with private key for internal use)
   */
  async rotateKeysWithPrivateRpc(): Promise<StoredKey> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      return this.rotateKeys();
    });
  }

  /**
   * RPC: Emergency key rotation
   */
  async emergencyRotateKeysRpc(reason: string): Promise<{ oldKid: string; newKid: string }> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      return this.emergencyRotateKeys(reason);
    });
  }

  /**
   * RPC: Check if rotation is needed
   */
  async shouldRotateKeysRpc(): Promise<boolean> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      return this.shouldRotateKeys();
    });
  }

  /**
   * RPC: Get configuration
   */
  async getConfigRpc(): Promise<KeyRotationConfig> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      return this.getConfig();
    });
  }

  /**
   * RPC: Update configuration
   */
  async updateConfigRpc(config: Partial<KeyRotationConfig>): Promise<void> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      return this.updateConfig(config);
    });
  }

  /**
   * RPC: Get status of all keys
   */
  async getStatusRpc(): Promise<{
    keys: Array<{
      kid: string;
      status: KeyStatus;
      createdAt: number;
      expiresAt?: number;
      revokedAt?: number;
      revokedReason?: string;
    }>;
    activeKeyId: string | null;
    lastRotation: number | null;
  }> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      const state = this.#getState();

      const keys = state.keys.map((k) => ({
        kid: k.kid,
        status: k.status,
        createdAt: k.createdAt,
        expiresAt: k.expiresAt,
        revokedAt: k.revokedAt,
        revokedReason: k.revokedReason,
      }));

      return {
        keys,
        activeKeyId: state.activeKeyId,
        lastRotation: state.lastRotation,
      };
    });
  }

  /** Export every tenant OIDC/VC signing generation and managed secret for an encrypted DR bundle. */
  async exportTenantBackupStateRpc(): Promise<KeyManagerTenantBackupSnapshot> {
    await this.#assertSnapshotAuthority();
    return normalizeKeyManagerTenantBackupSnapshot(await this.#sourceSnapshotState());
  }

  /** Freeze one immutable operation-owned view while the cross-store admission lock is held. */
  async startTenantBackupSnapshotRpc(snapshotId: string): Promise<void> {
    await this.#assertSnapshotAuthority();
    if (!TENANT_BACKUP_SNAPSHOT_ID.test(snapshotId))
      throw new Error('backup_key_manager_snapshot_id_invalid');
    const key = `${TENANT_BACKUP_SNAPSHOT_KEY_PREFIX}${snapshotId}`;
    const existing = await this.ctx.storage.get<KeyManagerTenantBackupSnapshot>(key);
    if (existing !== undefined) {
      await normalizeKeyManagerTenantBackupSnapshot(existing);
      return;
    }
    await this.ctx.storage.put(key, await this.#sourceSnapshotState());
  }

  /** Read the frozen state instead of a later live key generation. */
  async loadTenantBackupSnapshotRpc(snapshotId: string): Promise<KeyManagerTenantBackupSnapshot> {
    await this.#assertSnapshotAuthority();
    if (!TENANT_BACKUP_SNAPSHOT_ID.test(snapshotId))
      throw new Error('backup_key_manager_snapshot_id_invalid');
    const snapshot = await this.ctx.storage.get<KeyManagerTenantBackupSnapshot>(
      `${TENANT_BACKUP_SNAPSHOT_KEY_PREFIX}${snapshotId}`
    );
    if (snapshot === undefined) throw new Error('backup_key_manager_snapshot_missing');
    return normalizeKeyManagerTenantBackupSnapshot(snapshot);
  }

  async releaseTenantBackupSnapshotRpc(snapshotId: string): Promise<void> {
    if (!TENANT_BACKUP_SNAPSHOT_ID.test(snapshotId))
      throw new Error('backup_key_manager_snapshot_id_invalid');
    await this.ctx.storage.delete(`${TENANT_BACKUP_SNAPSHOT_KEY_PREFIX}${snapshotId}`);
  }

  async assertTenantBackupSnapshotReleasedRpc(snapshotId: string): Promise<void> {
    if (!TENANT_BACKUP_SNAPSHOT_ID.test(snapshotId))
      throw new Error('backup_key_manager_snapshot_id_invalid');
    if (
      (await this.ctx.storage.get(`${TENANT_BACKUP_SNAPSHOT_KEY_PREFIX}${snapshotId}`)) !==
      undefined
    )
      throw new Error('backup_key_manager_snapshot_not_released');
  }

  /**
   * Restore into an empty KeyManager, or replace the single bootstrap RSA key created while a
   * restore target is provisioned. Exact retries are idempotent.
   */
  async importTenantBackupStateRpc(
    input: unknown,
    options?: { replaceBootstrapKey?: boolean }
  ): Promise<{
    imported: boolean;
    rsaKeys: number;
    vcKeys: number;
    oidcKeys: number;
    secrets: number;
  }> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      const snapshot = await normalizeKeyManagerTenantBackupSnapshot(input);
      const current = this.#currentTenantBackupState();
      const exactRetry = keyManagerTenantBackupSnapshotsEqual(current, snapshot);
      const replaceBootstrapKey =
        options !== undefined &&
        !Array.isArray(options) &&
        Object.keys(options).length === 1 &&
        options.replaceBootstrapKey === true;
      const singleActivePurposeKey = (value: {
        keys: Array<{ kid: string; status: KeyStatus }>;
        activeKeyId: string | null;
      }) =>
        value.keys.length === 0
          ? value.activeKeyId === null
          : value.keys.length === 1 &&
            value.keys[0]?.status === 'active' &&
            value.activeKeyId === value.keys[0]?.kid;
      const bootstrapOnly =
        current.rsa.keys.length === 1 &&
        current.rsa.keys[0]?.status === 'active' &&
        current.rsa.activeKeyId === current.rsa.keys[0]?.kid &&
        current.rsa.lastRotation !== null &&
        Object.keys(current.rsa.secrets).length === 0 &&
        current.vcEc.keys.length === 0 &&
        singleActivePurposeKey(current.oidcEs256) &&
        singleActivePurposeKey(current.oidcPs256) &&
        singleActivePurposeKey(current.requestObjectEnc);
      if (
        !exactRetry &&
        !keyManagerTenantBackupSnapshotIsEmpty(current) &&
        !(replaceBootstrapKey && bootstrapOnly)
      )
        throw new Error('backup_key_manager_target_not_empty');
      if (!exactRetry) {
        await this.ctx.storage.transaction(async (transaction) => {
          await transaction.put({
            state: snapshot.rsa,
            ecState: snapshot.vcEc,
            oidcECState: snapshot.oidcEs256,
            oidcPS256State: snapshot.oidcPs256,
            requestObjectEncState: snapshot.requestObjectEnc,
          });
        });
        this.keyManagerState = structuredClone(snapshot.rsa);
        this.ecKeyManagerState = structuredClone(snapshot.vcEc);
        this.oidcECKeyManagerState = structuredClone(snapshot.oidcEs256);
        this.oidcPS256KeyManagerState = structuredClone(snapshot.oidcPs256);
        this.requestObjectEncKeyManagerState = structuredClone(snapshot.requestObjectEnc);
      }
      return {
        imported: !exactRetry,
        rsaKeys: snapshot.rsa.keys.length,
        vcKeys: snapshot.vcEc.keys.length,
        oidcKeys:
          snapshot.oidcEs256.keys.length +
          snapshot.oidcPs256.keys.length +
          snapshot.requestObjectEnc.keys.length,
        secrets: Object.keys(snapshot.rsa.secrets).length,
      };
    });
  }

  /** Re-verify key pairs and compare the complete stored rotation state after restore. */
  async verifyTenantBackupStateRpc(input: unknown): Promise<boolean> {
    await this.#assertSnapshotAuthority();
    const expected = await normalizeKeyManagerTenantBackupSnapshot(input);
    return keyManagerTenantBackupSnapshotsEqual(await this.#sourceSnapshotState(), expected);
  }

  // ==========================================
  // EC Key RPC Methods (Phase 9: SD-JWT VC)
  // ==========================================

  /**
   * RPC: Get the active EC signing key for a specific algorithm (without private key)
   */
  async getActiveECKeyRpc(algorithm: ECAlgorithm): Promise<Omit<StoredECKey, 'privatePEM'> | null> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      const activeKey = await this.getActiveECKey(algorithm);
      if (!activeKey) return null;
      return this.#sanitizeECKey(activeKey);
    });
  }

  /**
   * RPC: JWKS for resolving VC issuer signing keys. Active and overlap keys plus public keys
   * retained after normal rotation; never revoked keys or private members.
   */
  async getVcIssuerJwksRpc(): Promise<{ keys: JWK[] }> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      await this.#initializeECState();

      const state = this.#getECState();
      const now = Date.now();
      const keys = new Map<string, JWK>();
      for (const k of state.keys) {
        if (k.status !== 'revoked') keys.set(k.kid, this.#publicOnlyECJWK(k.publicJWK, k.kid));
      }
      for (const r of state.retiredPublicKeys ?? []) {
        if (r.retainUntil > now && !keys.has(r.kid)) {
          keys.set(r.kid, this.#publicOnlyECJWK(r.publicJWK, r.kid));
        }
      }
      return { keys: [...keys.values()] };
    });
  }

  /**
   * RPC: Get the active EC signing key with private key (for internal VC signing)
   */
  async getActiveECKeyWithPrivateRpc(algorithm: ECAlgorithm): Promise<StoredECKey | null> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      return this.getActiveECKey(algorithm);
    });
  }

  /** Sign the narrowly defined VCI access-token contract without exporting key material. */
  async signVCIAccessTokenRpc(input: SignVCIAccessTokenInput): Promise<SignVCIAccessTokenResult> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      const tenantId = input.tenantId?.trim();
      const userId = input.userId?.trim();
      const offerId = input.offerId?.trim();
      const configurationId = input.credentialConfigurationId?.trim();
      const issuer = input.issuer?.trim();
      const audience = input.audience?.trim();
      if (
        !tenantId ||
        tenantId.length > 128 ||
        !userId ||
        userId.length > 256 ||
        !offerId ||
        offerId.length > 512 ||
        !configurationId ||
        configurationId.length > 256 ||
        !issuer ||
        issuer.length > 2048 ||
        !audience ||
        audience.length > 2048
      ) {
        throw new Error('invalid_vci_access_token_signing_input');
      }
      // Bearer issuance tokens stay short-lived (OpenID4VCI §13.10).
      const expiresIn = Math.min(Math.max(input.expiresInSeconds ?? 300, 60), 300);
      const activeKey = await this.#ensureActiveVcES256Key();
      const privateKey = await importPKCS8(activeKey.privatePEM, 'ES256');
      const now = Math.floor(Date.now() / 1000);
      const jti = crypto.randomUUID();
      const token = await new SignJWT({
        tenant_id: tenantId,
        offer_id: offerId,
        credential_configuration_id: configurationId,
        scope: 'credential',
      })
        .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: activeKey.kid })
        .setSubject(userId)
        .setIssuedAt(now)
        .setJti(jti)
        .setExpirationTime(now + expiresIn)
        .setIssuer(issuer)
        .setAudience(audience)
        .sign(privateKey);
      return { token, kid: activeKey.kid, jti };
    });
  }

  /** Sign a bounded SD-JWT VC issuer payload without exporting the EC private key. */
  async signSDJWTIssuerRpc(
    payload: JWTPayload,
    options?: VcSigningOptions
  ): Promise<SignSDJWTIssuerResult> {
    const outcome = await runSamlDrCoveredOperation(
      this.env,
      undefined,
      async (): Promise<SignSDJWTIssuerResult | Refusal> => {
        // Admission comes first for every guarded RPC; the options are checked inside it, and an
        // expected refusal is returned, not thrown: an exception inside a replication write
        // permit is kept as an unconfirmed write and would block a later primary switch.
        const parsed = parseVcSigningOptions(options);
        if (!parsed) return { refused: 'invalid_vc_signing_options' };
        const requireX5c = parsed.requireX5c === true;
        if (!isSignablePayload(payload)) return { refused: 'invalid_sd_jwt_issuer_signing_input' };
        await this.#initializeState();
        const now = Math.floor(Date.now() / 1000);
        const issuer = typeof payload.iss === 'string' ? payload.iss.trim() : '';
        const vct = typeof payload.vct === 'string' ? payload.vct.trim() : '';
        const encodedBytes = jsonByteLength(payload);
        const disclosureHashes = payload._sd;
        if (
          !issuer ||
          issuer.length > 2048 ||
          !vct ||
          vct.length > 512 ||
          typeof payload.iat !== 'number' ||
          Math.abs(payload.iat - now) > 300 ||
          payload._sd_alg !== 'sha-256' ||
          encodedBytes === null ||
          encodedBytes > 64 * 1024 ||
          (disclosureHashes !== undefined &&
            (!Array.isArray(disclosureHashes) ||
              disclosureHashes.length > 128 ||
              disclosureHashes.some((value) => typeof value !== 'string' || value.length > 128)))
        ) {
          return { refused: 'invalid_sd_jwt_issuer_signing_input' };
        }
        const activeKey = await ensureVcKeyOrRefusal(() => this.#ensureActiveVcES256Key());
        if (!activeKey) return { refused: 'vc_issuer_key_retention_cap_reached' };
        const x5c = x5cHeader(
          activeKey,
          Date.now(),
          payload,
          trustedIssuingCaFingerprints(this.env.VC_X5C_ISSUING_CA_SHA256)
        );
        // An expected refusal is returned, not thrown: an exception inside a replication write
        // permit is kept as an unconfirmed write and would block a later switch of the primary.
        if (requireX5c && !x5c) return { refused: 'x5c_required' };
        const privateKey = await importPKCS8(activeKey.privatePEM, 'ES256');
        const token = await new SignJWT(payload)
          .setProtectedHeader({
            alg: 'ES256',
            typ: 'dc+sd-jwt',
            kid: activeKey.kid,
            ...x5c,
          })
          .sign(privateKey);
        return { token, kid: activeKey.kid };
      }
    );
    if ('refused' in outcome) throw new Error(outcome.refused);
    return outcome;
  }

  /**
   * Sign the request object of an administrator presentation (OpenID4VP 1.0, signed request with
   * the `decentralized_identifier` Client Identifier Prefix). Only that one fixed shape is
   * accepted, and the `kid` is the DID URL under which the DID document publishes the key.
   */
  async signAdminVPRequestRpc(payload: JWTPayload): Promise<SignSDJWTIssuerResult> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      const did = adminVPRequestDid(payload, Math.floor(Date.now() / 1000));
      if (!did) throw new Error('invalid_admin_vp_request_signing_input');
      const activeKey = await this.#ensureActiveVcES256Key();
      const privateKey = await importPKCS8(activeKey.privatePEM, 'ES256');
      const token = await new SignJWT(payload)
        .setProtectedHeader({
          alg: 'ES256',
          typ: 'oauth-authz-req+jwt',
          kid: `${did}#${encodeURIComponent(activeKey.kid)}`,
        })
        .sign(privateKey);
      return { token, kid: activeKey.kid };
    });
  }

  /**
   * Sign the request object of a HAIP login (OpenID4VP 1.0, `x509_hash` Client Identifier
   * Prefix, answered by `direct_post.jwt`). Only that one shape is accepted; the client id must be
   * the hash of the leaf certificate of the key's own `x5c` chain, which travels in the header (the
   * trust anchor excluded), and the response goes to the host the chain was issued for. Without a
   * usable chain nothing is signed.
   */
  async signHaipLoginRequestRpc(payload: JWTPayload): Promise<SignSDJWTIssuerResult> {
    const outcome = await runSamlDrCoveredOperation(
      this.env,
      undefined,
      async (): Promise<SignSDJWTIssuerResult | Refusal> => {
        await this.#initializeState();
        await this.#initializeECState();
        const now = Date.now();
        const shape = isSignablePayload(payload)
          ? haipLoginRequestShape(payload, Math.floor(now / 1000))
          : null;
        if (!shape) return { refused: 'invalid_haip_login_request_signing_input' };
        const key = await ensureVcKeyOrRefusal(() => this.#ensureActiveVcES256Key());
        if (!key) return { refused: 'vc_issuer_key_retention_cap_reached' };
        const chain = key.certificateChain;
        if (
          !chain ||
          chain.length === 0 ||
          typeof key.certificateNotAfter !== 'number' ||
          key.certificateNotAfter <= now ||
          (payload.exp as number) * 1000 > key.certificateNotAfter ||
          !key.certificateCaSha256 ||
          !trustedIssuingCaFingerprints(this.env.VC_X5C_ISSUING_CA_SHA256).includes(
            key.certificateCaSha256
          ) ||
          key.certificateIssuerHost !== shape.responseHost ||
          (await x509HashClientIdOf(chain)) !== `${HAIP_LOGIN_CLIENT_ID_PREFIX}${shape.clientHash}`
        ) {
          return { refused: 'x5c_required' };
        }
        const privateKey = await importPKCS8(key.privatePEM, 'ES256');
        const token = await new SignJWT(payload)
          .setProtectedHeader({ alg: 'ES256', typ: 'oauth-authz-req+jwt', x5c: chain })
          .sign(privateKey);
        return { token, kid: key.kid };
      }
    );
    if ('refused' in outcome) throw new Error(outcome.refused);
    return outcome;
  }

  /**
   * What a HAIP login request names the verifier by: the `x509_hash` client identifier of the
   * key's usable chain, the subject key identifier of its issuing CA (for the wallet's DCQL
   * `trusted_authorities`) and the host the chain was issued for. Null when the key has no
   * usable chain, so the login is not offered.
   */
  async getHaipLoginVerifierRpc(): Promise<{
    clientId: string;
    issuingCaAki: string;
    issuerHost: string;
    chainNotAfter: number;
  } | null> {
    const outcome = await runSamlDrCoveredOperation(
      this.env,
      undefined,
      async (): Promise<
        | { clientId: string; issuingCaAki: string; issuerHost: string; chainNotAfter: number }
        | null
        | Refusal
      > => {
        await this.#initializeState();
        await this.#initializeECState();
        const key = await ensureVcKeyOrRefusal(() => this.#ensureActiveVcES256Key());
        if (!key) return { refused: 'vc_issuer_key_retention_cap_reached' };
        const chain = key.certificateChain;
        if (
          !chain ||
          chain.length !== 2 ||
          typeof key.certificateNotAfter !== 'number' ||
          key.certificateNotAfter <= Date.now() ||
          !key.certificateIssuerHost ||
          !key.certificateCaSha256 ||
          !trustedIssuingCaFingerprints(this.env.VC_X5C_ISSUING_CA_SHA256).includes(
            key.certificateCaSha256
          )
        ) {
          return null;
        }
        const aki = parseCertificate(base64ToBytes(chain[1])).subjectKeyIdentifier;
        if (!aki) return null;
        return {
          clientId: await x509HashClientIdOf(chain),
          issuingCaAki: base64UrlOf(aki),
          issuerHost: key.certificateIssuerHost,
          chainNotAfter: key.certificateNotAfter,
        };
      }
    );
    if (outcome !== null && 'refused' in outcome) throw new Error(outcome.refused);
    return outcome;
  }

  /**
   * Sign a status list token without exporting key material. Two fixed shapes are accepted:
   * the Token Status List (https `iss`, `sub` the list URI on the same origin, `ttl`,
   * `status_list: { bits, lst }`) and the legacy Bitstring Status List JWT (did:web `iss`, `vc`).
   */
  async signStatusListCredentialRpc(
    payload: JWTPayload,
    options?: VcSigningOptions
  ): Promise<SignStatusListCredentialResult> {
    const outcome = await runSamlDrCoveredOperation(
      this.env,
      undefined,
      async (): Promise<SignStatusListCredentialResult | Refusal> => {
        const parsed = parseVcSigningOptions(options);
        if (!parsed) return { refused: 'invalid_vc_signing_options' };
        const requireX5c = parsed.requireX5c === true;
        await this.#initializeState();
        const now = Math.floor(Date.now() / 1000);
        if (!isSignablePayload(payload)) return { refused: 'invalid_status_list_signing_input' };
        const encodedBytes = jsonByteLength(payload);
        if (encodedBytes === null || encodedBytes > 4 * 1024 * 1024)
          return { refused: 'invalid_status_list_signing_input' };
        const valid =
          'status_list' in payload
            ? isValidTokenStatusListPayload(payload, now)
            : isValidLegacyStatusListPayload(payload, now);
        if (!valid) {
          return { refused: 'invalid_status_list_signing_input' };
        }
        const activeKey = await ensureVcKeyOrRefusal(() => this.#ensureActiveVcES256Key());
        if (!activeKey) return { refused: 'vc_issuer_key_retention_cap_reached' };
        // HAIP asks for `x5c` on the Token Status List only; the legacy Bitstring Status List
        // credential (a did:web `vc` JWT) keeps resolving its key through the DID document.
        const x5c =
          'status_list' in payload
            ? x5cHeader(
                activeKey,
                Date.now(),
                payload,
                trustedIssuingCaFingerprints(this.env.VC_X5C_ISSUING_CA_SHA256)
              )
            : undefined;
        if (requireX5c && !x5c) return { refused: 'x5c_required' };
        const privateKey = await importPKCS8(activeKey.privatePEM, 'ES256');
        const token = await new SignJWT(payload)
          .setProtectedHeader({
            alg: 'ES256',
            typ: 'statuslist+jwt',
            kid: activeKey.kid,
            ...x5c,
          })
          .sign(privateKey);
        return { token, kid: activeKey.kid };
      }
    );
    if ('refused' in outcome) throw new Error(outcome.refused);
    return outcome;
  }

  /**
   * RPC: Get all EC public keys (for JWKS endpoint)
   */
  async getAllECPublicKeysRpc(): Promise<JWK[]> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      return this.getAllECPublicKeys();
    });
  }

  /**
   * RPC: Rotate EC keys for a specific algorithm
   */
  async rotateECKeysRpc(algorithm: ECAlgorithm): Promise<Omit<StoredECKey, 'privatePEM'>> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      const newKey = await this.rotateECKeys(algorithm);
      return this.#sanitizeECKey(newKey);
    });
  }

  /**
   * RPC: Rotate EC keys with private key (for internal use)
   */
  async rotateECKeysWithPrivateRpc(algorithm: ECAlgorithm): Promise<StoredECKey> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      return this.rotateECKeys(algorithm);
    });
  }

  /**
   * RPC: Emergency EC key rotation
   */
  async emergencyRotateECKeysRpc(
    algorithm: ECAlgorithm,
    reason: string
  ): Promise<{ oldKid: string; newKid: string }> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      return this.emergencyRotateECKeys(algorithm, reason);
    });
  }

  /**
   * RPC: Revoke one VC issuer EC key by kid, wherever it is in its lifecycle. An active key is
   * replaced through emergency rotation; an overlap key is revoked at once; a public key retained
   * after normal rotation is dropped. Credentials signed with the key then no longer verify.
   */
  async revokeVcIssuerKeyRpc(
    kid: string,
    reason: string
  ): Promise<{ revoked: boolean; replacedBy?: string }> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      await this.#initializeECState();
      const normalizedKid = typeof kid === 'string' ? kid.trim() : '';
      if (!normalizedKid || normalizedKid.length > 256) throw new Error('invalid_kid');
      if (
        typeof reason !== 'string' ||
        reason.trim().length < 10 ||
        new TextEncoder().encode(reason).byteLength > MAX_KEY_REVOCATION_REASON_BYTES
      ) {
        throw new Error('invalid_revocation_reason');
      }

      const state = this.#getECState();
      const activeAlgorithm = (Object.keys(state.activeKeyIds) as ECAlgorithm[]).find(
        (algorithm) => state.activeKeyIds[algorithm] === normalizedKid
      );
      if (activeAlgorithm) {
        const result = await this.emergencyRotateECKeys(activeAlgorithm, reason);
        return { revoked: true, replacedBy: result.newKid };
      }

      const now = Date.now();
      let revoked = false;
      const key = state.keys.find((k) => k.kid === normalizedKid);
      if (key && key.status !== 'revoked') {
        key.status = 'revoked';
        key.revokedAt = now;
        key.revokedReason = reason;
        revoked = true;
      }
      const retained = state.retiredPublicKeys ?? [];
      if (retained.some((r) => r.kid === normalizedKid)) {
        state.retiredPublicKeys = retained.filter((r) => r.kid !== normalizedKid);
        revoked = true;
      }
      if (!revoked) return { revoked: false };

      await this.#saveECState();
      log.warn('VC issuer EC key revoked', {
        kid: normalizedKid,
        reason,
        timestamp: new Date(now).toISOString(),
      });
      return { revoked: true };
    });
  }

  /**
   * RPC: Attach a certificate chain to one VC issuer ES256 key. The chain is validated here: the
   * leaf must certify exactly this key and name the issuer host, every certificate must be valid
   * now and signed by the next, and no certificate may be self-signed (the trust anchor is never
   * delivered). Later credentials and status list tokens signed with the key carry it as `x5c`.
   */
  async setVcIssuerKeyCertificateChainRpc(
    input: SetVcIssuerKeyCertificateChainInput
  ): Promise<{ kid: string; leafNotAfter: number; chainNotAfter: number }> {
    type Registered = { kid: string; leafNotAfter: number; chainNotAfter: number };
    const outcome = await runSamlDrCoveredOperation(
      this.env,
      undefined,
      async (): Promise<Registered | Refusal> => {
        // Admission comes first for every guarded RPC. Every expected rejection from here on,
        // including a bad argument, is returned, not thrown, so no write permit is left open.
        const kid = typeof input?.kid === 'string' ? input.kid.trim() : '';
        if (!kid || kid.length > 256) return { refused: 'invalid_kid' };
        if (typeof input.issuerHost !== 'string') return { refused: 'invalid_issuer_host' };
        const host = input.issuerHost.trim().toLowerCase();
        await this.#initializeState();
        await this.#initializeECState();
        const findKey = (): StoredECKey | undefined =>
          this.#getECState().keys.find(
            (candidate) =>
              candidate.kid === kid &&
              candidate.algorithm === 'ES256' &&
              candidate.status !== 'revoked'
          );
        const target = findKey();
        if (!target) return { refused: 'vc_issuer_key_not_found' };

        const trusted = trustedIssuingCaFingerprints(this.env.VC_X5C_ISSUING_CA_SHA256);
        if (trusted.length === 0) return { refused: 'vc_x5c_trust_anchor_not_configured' };

        // Only a failed save (an unknown outcome) throws from inside the permit.
        let info: Awaited<ReturnType<typeof validateVcSigningChain>>;
        try {
          info = await validateVcSigningChain(input.chain, {
            publicKey: target.publicJWK,
            issuerHost: host,
            now: Date.now(),
            expectedLength: 2,
            authrimProfile: true,
            trustedFinalCertificateSha256: trusted,
          });
        } catch (error) {
          return { refused: error instanceof Error ? error.message : 'invalid_certificate_chain' };
        }

        // The validation awaited: look the key up again, so a key that was revoked or cleaned up
        // in the meantime is neither updated nor reported as updated.
        const key = findKey();
        if (
          !key ||
          key.publicJWK.x !== target.publicJWK.x ||
          key.publicJWK.y !== target.publicJWK.y
        ) {
          return { refused: 'vc_issuer_key_not_found' };
        }
        const previous = {
          certificateChain: key.certificateChain,
          certificateNotAfter: key.certificateNotAfter,
          certificateIssuerHost: key.certificateIssuerHost,
          certificateCaSha256: key.certificateCaSha256,
        };
        key.certificateChain = info.x5c;
        key.certificateNotAfter = info.chainNotAfter;
        key.certificateIssuerHost = host;
        key.certificateCaSha256 = info.finalCertificateSha256;
        try {
          await this.#saveECState();
        } catch (error) {
          // Keep memory equal to storage: a chain that was not saved must not be signed with.
          Object.assign(key, previous);
          throw error;
        }
        log.info('VC issuer key certificate chain stored', {
          kid,
          chainNotAfter: new Date(info.chainNotAfter).toISOString(),
        });
        return { kid, leafNotAfter: info.leafNotAfter, chainNotAfter: info.chainNotAfter };
      }
    );
    if ('refused' in outcome) throw new Error(outcome.refused);
    return outcome;
  }

  /**
   * RPC: The active VC ES256 signing key and the state of its certificate chain, so the component
   * that holds the issuing CA can tell whether a certificate is needed. The key is created if it
   * does not exist yet. No private material and no chain is returned.
   */
  async getVcSigningCertificateStateRpc(): Promise<VcSigningCertificateState> {
    const outcome = await runSamlDrCoveredOperation(
      this.env,
      undefined,
      async (): Promise<VcSigningCertificateState | Refusal> => {
        await this.#initializeState();
        await this.#initializeECState();
        const key = await ensureVcKeyOrRefusal(() => this.#ensureActiveVcES256Key());
        if (!key) return { refused: 'vc_issuer_key_retention_cap_reached' };
        const jwk = key.publicJWK;
        return {
          kid: key.kid,
          publicJWK: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
          issuerHost: key.certificateIssuerHost ?? null,
          caSha256: key.certificateCaSha256 ?? null,
          chainNotAfter: key.certificateNotAfter ?? null,
        };
      }
    );
    if ('refused' in outcome) throw new Error(outcome.refused);
    return outcome;
  }

  /**
   * RPC: Get EC key status for all algorithms
   */
  async getECStatusRpc(): Promise<{
    keys: Array<{
      kid: string;
      algorithm: ECAlgorithm;
      curve: ECCurve;
      status: KeyStatus;
      createdAt: number;
      expiresAt?: number;
      revokedAt?: number;
      revokedReason?: string;
    }>;
    activeKeyIds: Record<ECAlgorithm, string | null>;
    lastRotation: number | null;
  }> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      await this.#initializeECState();
      const state = this.#getECState();

      const keys = state.keys.map((k) => ({
        kid: k.kid,
        algorithm: k.algorithm,
        curve: k.curve,
        status: k.status,
        createdAt: k.createdAt,
        expiresAt: k.expiresAt,
        revokedAt: k.revokedAt,
        revokedReason: k.revokedReason,
      }));

      return {
        keys,
        activeKeyIds: state.activeKeyIds,
        lastRotation: state.lastRotation,
      };
    });
  }

  // ==========================================
  // Internal Methods
  // ==========================================

  /**
   * Ensure state is initialized
   * Called by public methods for backward compatibility
   *
   * Note: With blockConcurrencyWhile() in constructor, this is now a no-op guard.
   */
  async #initializeState(): Promise<void> {
    await this.initialization;
    if (this.#reloadBeforeOperation) await this.#loadExistingState();
    if (this.#requiresAdmittedInitialization) {
      this.#admittedInitialization ??= this.#initializeStateBlocking()
        .then(() => {
          this.#requiresAdmittedInitialization = false;
        })
        .finally(() => {
          this.#admittedInitialization = null;
        });
      await this.#admittedInitialization;
    }
    if (this.keyManagerState !== null) {
      return;
    }

    // Safety fallback (should not happen with blockConcurrencyWhile)
    log.warn('initializeState called but not initialized - this should not happen');
    await this.#initializeStateBlocking();
  }

  /**
   * Migrate from old isActive field to new status field
   * This is a one-time migration for backward compatibility
   */
  async #migrateIsActiveToStatus(): Promise<void> {
    const state = this.#getState();
    let needsMigration = false;

    for (const key of state.keys) {
      if ('isActive' in key && !('status' in key)) {
        needsMigration = true;
        // @ts-expect-error - migration from old schema
        (key as StoredKey).status = key.isActive ? 'active' : 'overlap';
        // @ts-expect-error - migration from old schema
        delete key.isActive;
      }
    }

    if (needsMigration) {
      log.info('Migrated isActive to status field');
      await this.#saveState();
    }
  }

  /**
   * Get state with assertion that it has been initialized
   */
  #getState(): KeyManagerState {
    if (!this.keyManagerState) {
      throw new Error('KeyManager state not initialized');
    }
    return this.keyManagerState;
  }

  #currentTenantBackupState(): KeyManagerTenantBackupSnapshot {
    return withoutVcCertificateChains(
      structuredClone({
        kind: 'authrim.key_manager_tenant_backup.v1',
        version: 1,
        rsa: { ...this.#getState(), secrets: this.#getState().secrets ?? {} },
        vcEc: this.#getECState(),
        oidcEs256: this.#getOIDCECState(),
        oidcPs256: this.#getOIDCPS256State(),
        requestObjectEnc: this.#getRequestObjectEncState(),
      })
    );
  }

  /** A failed save must never turn an uncommitted in-memory value into backup authority. */
  async #sourceSnapshotState(): Promise<KeyManagerTenantBackupSnapshot> {
    if (this.env.ENABLE_SAML_DR_EXPORT !== 'true') return this.#currentTenantBackupState();
    return this.ctx.storage.transaction(async (storage) => {
      const [rsa, vcEc, oidcEs256, oidcPs256, requestObjectEnc] = await Promise.all([
        storage.get<KeyManagerState>('state'),
        storage.get<ECKeyManagerState>('ecState'),
        storage.get<OIDCECKeyManagerState>('oidcECState'),
        storage.get<OIDCPS256KeyManagerState>('oidcPS256State'),
        storage.get<RequestObjectEncKeyManagerState>('requestObjectEncState'),
      ]);
      if (!rsa || !vcEc || !oidcEs256 || !oidcPs256 || !requestObjectEnc)
        throw new Error('saml_dr_key_manager_authority_uninitialized');
      return withoutVcCertificateChains(
        structuredClone({
          kind: 'authrim.key_manager_tenant_backup.v1',
          version: 1,
          rsa: { ...rsa, secrets: rsa.secrets ?? {} },
          vcEc,
          oidcEs256,
          oidcPs256,
          requestObjectEnc,
        })
      );
    });
  }

  /**
   * Save state to durable storage
   */
  async #saveState(): Promise<void> {
    if (this.keyManagerState) {
      await this.#persistSourceState('state', this.keyManagerState);
    }
  }

  /**
   * Save EC key state to durable storage
   */
  async #saveECState(): Promise<void> {
    if (this.ecKeyManagerState) {
      await this.#persistSourceState('ecState', this.ecKeyManagerState);
    }
  }

  async #saveOIDCECState(): Promise<void> {
    if (this.oidcECKeyManagerState) {
      await this.#persistSourceState('oidcECState', this.oidcECKeyManagerState);
    }
  }

  async #saveOIDCPS256State(): Promise<void> {
    if (this.oidcPS256KeyManagerState) {
      await this.#persistSourceState('oidcPS256State', this.oidcPS256KeyManagerState);
    }
  }

  async #saveRequestObjectEncState(): Promise<void> {
    if (this.requestObjectEncKeyManagerState) {
      await this.#persistSourceState('requestObjectEncState', this.requestObjectEncKeyManagerState);
    }
  }

  async #persistSourceState(key: string, value: unknown): Promise<void> {
    try {
      await this.ctx.storage.put(key, value);
    } catch (error) {
      if (this.env.ENABLE_SAML_DR_EXPORT === 'true') this.#reloadBeforeOperation = true;
      throw error;
    }
  }

  #getRequestObjectEncState(): RequestObjectEncKeyManagerState {
    if (!this.requestObjectEncKeyManagerState) {
      throw new Error('Request object encryption KeyManager state not initialized');
    }
    return this.requestObjectEncKeyManagerState;
  }

  #getAllRequestObjectEncPublicKeys(): JWK[] {
    const now = Date.now();
    return this.#getRequestObjectEncState()
      .keys.filter((key) => isUsableRequestObjectEncKey(key, now))
      .map((key) => key.publicJWK);
  }

  async #ensureActiveRequestObjectEncKey(): Promise<StoredKey> {
    const state = this.#getRequestObjectEncState();
    const active = state.keys.find(
      (key) => key.kid === state.activeKeyId && key.status === 'active'
    );
    if (active) return active;

    if (!this.requestObjectEncCreationPromise) {
      this.requestObjectEncCreationPromise = this.#rotateRequestObjectEncKey().finally(() => {
        this.requestObjectEncCreationPromise = null;
      });
    }
    return this.requestObjectEncCreationPromise;
  }

  async #rotateRequestObjectEncKey(): Promise<StoredKey> {
    const state = this.#getRequestObjectEncState();
    const now = Date.now();
    const previousActive = state.keys.find((key) => key.status === 'active');
    if (previousActive) {
      // Apps may still encrypt to the previous key until they fetch the JWKS again.
      previousActive.status = 'overlap';
      previousActive.expiresAt = now + 24 * 60 * 60 * 1000;
    }

    const kid = `request-object-enc-${now}-${crypto.randomUUID()}`;
    const keySet = await generateKeySet(kid);
    const newKey: StoredKey = {
      kid,
      publicJWK: { ...keySet.publicJWK, kid, use: 'enc', alg: REQUEST_OBJECT_ENCRYPTION_KEY_ALG },
      privatePEM: keySet.privatePEM,
      createdAt: now,
      status: 'active',
    };
    state.keys.push(newKey);
    state.activeKeyId = kid;
    state.lastRotation = now;
    state.keys = state.keys.filter(
      (key) => key.status === 'active' || !key.expiresAt || key.expiresAt >= now
    );
    await this.#saveRequestObjectEncState();
    return newKey;
  }

  #getOIDCECState(): OIDCECKeyManagerState {
    if (!this.oidcECKeyManagerState) {
      throw new Error('OIDC EC KeyManager state not initialized');
    }
    return this.oidcECKeyManagerState;
  }

  #getOIDCPS256State(): OIDCPS256KeyManagerState {
    if (!this.oidcPS256KeyManagerState) {
      throw new Error('OIDC PS256 KeyManager state not initialized');
    }
    return this.oidcPS256KeyManagerState;
  }

  #getAllOIDCECPublicKeys(): JWK[] {
    return this.#getOIDCECState()
      .keys.filter((key) => key.status !== 'revoked')
      .map((key) => key.publicJWK);
  }

  #getAllOIDCPS256PublicKeys(): JWK[] {
    return this.#getOIDCPS256State()
      .keys.filter((key) => key.status !== 'revoked')
      .map((key) => key.publicJWK);
  }

  /**
   * The VC issuer's ES256 signing key, created on first use like the RS256 OIDC key. Concurrent
   * first signers share one creation so a new environment never gets two active keys.
   */
  async #ensureActiveVcES256Key(): Promise<StoredECKey> {
    const active = await this.getActiveECKey('ES256');
    if (active) return active;
    if (!this.vcES256CreationPromise) {
      this.vcES256CreationPromise = this.rotateECKeys('ES256').finally(() => {
        this.vcES256CreationPromise = null;
      });
    }
    return this.vcES256CreationPromise;
  }

  async #ensureActiveOIDCES256Key(): Promise<StoredECKey> {
    const state = this.#getOIDCECState();
    const active = state.keys.find(
      (key) => key.kid === state.activeKeyId && key.status === 'active'
    );
    if (active) return active;

    if (!this.oidcES256CreationPromise) {
      this.oidcES256CreationPromise = this.#rotateOIDCES256Key().finally(() => {
        this.oidcES256CreationPromise = null;
      });
    }
    return this.oidcES256CreationPromise;
  }

  async #rotateOIDCES256Key(): Promise<StoredECKey> {
    const state = this.#getOIDCECState();
    const now = Date.now();
    const previousActive = state.keys.find((key) => key.status === 'active');
    if (previousActive) {
      previousActive.status = 'overlap';
      previousActive.expiresAt = now + 24 * 60 * 60 * 1000;
    }

    const kid = `oidc-es256-${now}-${crypto.randomUUID()}`;
    const keySet = await generateECKeySet(kid, 'ES256');
    const newKey: StoredECKey = {
      kid,
      algorithm: 'ES256',
      curve: 'P-256',
      publicJWK: keySet.publicJWK,
      privatePEM: keySet.privatePEM,
      createdAt: now,
      status: 'active',
    };
    state.keys.push(newKey);
    state.activeKeyId = kid;
    state.lastRotation = now;
    state.keys = state.keys.filter(
      (key) => key.status === 'active' || !key.expiresAt || key.expiresAt >= now
    );
    await this.#saveOIDCECState();
    return newKey;
  }

  async #ensureActiveOIDCPS256Key(): Promise<StoredKey> {
    const state = this.#getOIDCPS256State();
    const active = state.keys.find(
      (key) => key.kid === state.activeKeyId && key.status === 'active'
    );
    if (active) return active;

    if (!this.oidcPS256CreationPromise) {
      this.oidcPS256CreationPromise = this.#rotateOIDCPS256Key().finally(() => {
        this.oidcPS256CreationPromise = null;
      });
    }
    return this.oidcPS256CreationPromise;
  }

  async #rotateOIDCPS256Key(): Promise<StoredKey> {
    const state = this.#getOIDCPS256State();
    const now = Date.now();
    const previousActive = state.keys.find((key) => key.status === 'active');
    if (previousActive) {
      previousActive.status = 'overlap';
      previousActive.expiresAt = now + 24 * 60 * 60 * 1000;
    }

    const kid = `oidc-ps256-${now}-${crypto.randomUUID()}`;
    const keySet = await generateKeySet(kid);
    const newKey: StoredKey = {
      kid,
      publicJWK: { ...keySet.publicJWK, kid, use: 'sig', alg: 'PS256' },
      privatePEM: keySet.privatePEM,
      createdAt: now,
      status: 'active',
    };
    state.keys.push(newKey);
    state.activeKeyId = kid;
    state.lastRotation = now;
    state.keys = state.keys.filter(
      (key) => key.status === 'active' || !key.expiresAt || key.expiresAt >= now
    );
    await this.#saveOIDCPS256State();
    return newKey;
  }

  /**
   * Ensure EC state is initialized
   */
  async #initializeECState(): Promise<void> {
    if (this.ecKeyManagerState !== null) {
      return;
    }

    // Safety fallback (should not happen with blockConcurrencyWhile)
    log.warn('initializeECState called but not initialized - this should not happen');
    const storedECState = await this.ctx.storage.get<ECKeyManagerState>('ecState');

    if (storedECState) {
      this.ecKeyManagerState = storedECState;
    } else {
      this.ecKeyManagerState = {
        keys: [],
        activeKeyIds: {
          ES256: null,
          ES384: null,
          ES512: null,
        },
        config: {
          rotationIntervalDays: 90,
          retentionPeriodDays: 30,
        },
        lastRotation: null,
      };
      await this.#saveECState();
    }
  }

  /**
   * Get EC state with assertion that it has been initialized
   */
  #getECState(): ECKeyManagerState {
    if (!this.ecKeyManagerState) {
      throw new Error('EC KeyManager state not initialized');
    }
    return this.ecKeyManagerState;
  }

  /**
   * Generate a new key and add it to the key set
   */
  async generateNewKey(options: { modulusLength?: number } = {}): Promise<StoredKey> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();

      const kid = this.#generateKeyId();
      const keySet = await generateKeySet(kid, options.modulusLength);

      log.debug('generateNewKey - keySet', {
        kid,
        hasPEM: !!keySet.privatePEM,
        pemLength: keySet.privatePEM?.length,
      });

      const newKey: StoredKey = {
        kid,
        publicJWK: keySet.publicJWK,
        privatePEM: keySet.privatePEM,
        createdAt: Date.now(),
        status: 'overlap', // New keys start as overlap until set as active
      };

      log.debug('generateNewKey - newKey', {
        kid: newKey.kid,
        hasPEM: !!newKey.privatePEM,
        pemLength: newKey.privatePEM?.length,
      });

      const state = this.#getState();
      state.keys.push(newKey);
      await this.#saveState();

      return newKey;
    });
  }

  /**
   * Set a key as the active signing key
   */
  async setActiveKey(kid: string): Promise<void> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();

      const state = this.#getState();
      const key = state.keys.find((k) => k.kid === kid);
      if (!key) {
        // SECURITY: Do not expose kid value in error to prevent key enumeration
        throw new Error('Key not found');
      }

      // Set previous active key to overlap status with expiry
      const previousActiveKey = state.keys.find((k) => k.status === 'active');
      if (previousActiveKey) {
        previousActiveKey.status = 'overlap';
        // Set expiry to 24 hours from now (overlap period)
        previousActiveKey.expiresAt = Date.now() + 24 * 60 * 60 * 1000;
      }

      // Set new key as active
      key.status = 'active';
      state.activeKeyId = kid;
      await this.#saveState();
    });
  }

  /**
   * Get the active signing key
   */
  async getActiveKey(): Promise<StoredKey | null> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();

      const state = this.#getState();
      if (!state.activeKeyId) {
        return null;
      }

      return state.keys.find((k) => k.kid === state.activeKeyId) || null;
    });
  }

  /**
   * Get all public keys (for JWKS endpoint)
   * Excludes revoked keys from JWKS
   */
  async getAllPublicKeys(): Promise<JWK[]> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();

      const state = this.#getState();
      // Only return active and overlap keys, exclude revoked keys
      return state.keys.filter((k) => k.status !== 'revoked').map((k) => k.publicJWK);
    });
  }

  /**
   * Get a specific key by kid
   */
  async getKey(kid: string): Promise<StoredKey | null> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();

      const state = this.#getState();
      return state.keys.find((k) => k.kid === kid) || null;
    });
  }

  /**
   * Rotate keys (generate new key and set as active)
   */
  async rotateKeys(options: { modulusLength?: number } = {}): Promise<StoredKey> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();

      // Generate new key
      const newKey = await this.generateNewKey(options);

      // Set new key as active
      await this.setActiveKey(newKey.kid);

      // Update last rotation timestamp
      const state = this.#getState();
      state.lastRotation = Date.now();

      // Clean up expired keys
      await this.#cleanupExpiredKeys();

      await this.#saveState();

      // Return the key from state.keys to ensure it's the current version after cleanup
      const rotatedKey = state.keys.find((k) => k.kid === newKey.kid);
      if (!rotatedKey) {
        throw new Error('Rotated key not found in state after rotation');
      }

      log.debug('rotateKeys - returning key', {
        kid: rotatedKey.kid,
        hasPEM: !!rotatedKey.privatePEM,
        pemLength: rotatedKey.privatePEM?.length,
      });

      // Explicitly reconstruct the object to ensure all properties are enumerable and serializable
      const result: StoredKey = {
        kid: rotatedKey.kid,
        publicJWK: rotatedKey.publicJWK,
        privatePEM: rotatedKey.privatePEM,
        createdAt: rotatedKey.createdAt,
        status: rotatedKey.status,
        certificatePEM: rotatedKey.certificatePEM,
        certificateCreatedAt: rotatedKey.certificateCreatedAt,
        certificateSha256Thumbprint: rotatedKey.certificateSha256Thumbprint,
        expiresAt: rotatedKey.expiresAt,
        revokedAt: rotatedKey.revokedAt,
        revokedReason: rotatedKey.revokedReason,
      };

      log.debug('rotateKeys - reconstructed result', {
        kid: result.kid,
        hasPEM: !!result.privatePEM,
        pemLength: result.privatePEM?.length,
      });

      return result;
    });
  }

  /**
   * Emergency key rotation for key compromise scenarios
   * Immediately revokes the current active key and generates a new one
   *
   * @param reason - Reason for emergency rotation (for audit purposes)
   * @returns Object with old and new key IDs
   */
  async emergencyRotateKeys(reason: string): Promise<{ oldKid: string; newKid: string }> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();

      const state = this.#getState();
      const now = Date.now();

      // Find current active key
      const currentActiveKey = state.keys.find((k) => k.status === 'active');
      if (!currentActiveKey) {
        throw new Error('No active key found to revoke');
      }

      // Generate new key
      const newKey = await this.generateNewKey();
      newKey.status = 'active';

      // Immediately revoke old key (NO overlap period for security)
      currentActiveKey.status = 'revoked';
      currentActiveKey.revokedAt = now;
      currentActiveKey.revokedReason = reason;

      // Update state
      state.activeKeyId = newKey.kid;
      state.lastRotation = now;
      await this.#saveState();

      log.warn('Emergency rotation executed', {
        oldKid: currentActiveKey.kid,
        newKid: newKey.kid,
        reason,
        timestamp: new Date(now).toISOString(),
      });

      return {
        oldKid: currentActiveKey.kid,
        newKid: newKey.kid,
      };
    });
  }

  /**
   * Clean up expired keys based on retention period
   * - Active keys: never removed
   * - Overlap keys: removed after expiry
   * - Revoked keys: kept for retention period for audit purposes
   */
  async #cleanupExpiredKeys(): Promise<void> {
    const state = this.#getState();
    const retentionMillis = state.config.retentionPeriodDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    state.keys = state.keys.filter((k) => {
      // Always keep active keys
      if (k.status === 'active') {
        return true;
      }

      // Remove overlap keys that have expired
      if (k.status === 'overlap' && k.expiresAt && k.expiresAt < now) {
        return false;
      }

      // Remove revoked keys after retention period (for audit purposes)
      if (k.status === 'revoked' && k.revokedAt) {
        const revokedAge = now - k.revokedAt;
        return revokedAge < retentionMillis;
      }

      // Keep everything else
      return true;
    });
  }

  /**
   * Check if key rotation is needed
   */
  async shouldRotateKeys(): Promise<boolean> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();

      const state = this.#getState();
      if (!state.lastRotation) {
        return true; // No keys have been generated yet
      }

      const rotationIntervalMillis = state.config.rotationIntervalDays * 24 * 60 * 60 * 1000;
      const timeSinceLastRotation = Date.now() - state.lastRotation;

      return timeSinceLastRotation >= rotationIntervalMillis;
    });
  }

  /**
   * Update key rotation configuration
   */
  async updateConfig(config: Partial<KeyRotationConfig>): Promise<void> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();

      const state = this.#getState();
      state.config = {
        ...state.config,
        ...config,
      };

      await this.#saveState();
    });
  }

  /**
   * Get current configuration
   */
  async getConfig(): Promise<KeyRotationConfig> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      const state = this.#getState();
      return state.config;
    });
  }

  /** Idempotent enrollment on the authorized Mapping Set write path; metadata only. */
  async provisionMappingHashKeyRpc(): Promise<{ kid: string }> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      const secret = await this.#getOrCreateSecret(MAPPING_HASH_SECRET_REF);
      return { kid: secret.active.kid };
    });
  }

  /** Compare-and-swap rotation; retrying the previous kid returns the completed rotation. */
  async rotateMappingHashKeyRpc(expectedKid: string): Promise<{ kid: string }> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      if (typeof expectedKid !== 'string' || !expectedKid || expectedKid.length > 256)
        throw new Error('mapping_hash_key_conflict');
      if (!(await this.getExistingSecretRpc(MAPPING_HASH_SECRET_REF)))
        throw new Error('mapping_hash_key_missing');
      // Refresh an admitted instance after snapshot/restore boundaries, without enrolling a missing key.
      await this.#initializeState();
      const state = this.#getState();
      const current: StoredSecret | undefined = state.secrets?.[MAPPING_HASH_SECRET_REF];
      if (!current) throw new Error('mapping_hash_key_missing');
      if (current.previous?.kid === expectedKid) return { kid: current.active.kid };
      if (current.active.kid !== expectedKid) throw new Error('mapping_hash_key_conflict');
      const next: StoredSecret = {
        secretRef: MAPPING_HASH_SECRET_REF,
        active: this.#generateSecretVersion(),
        previous: current.active,
        updatedAt: Date.now(),
      };
      const secrets = { ...state.secrets, [MAPPING_HASH_SECRET_REF]: next };
      await this.ctx.storage.put('state', { ...state, secrets });
      state.secrets = secrets;
      return { kid: next.active.kid };
    });
  }

  async getOrCreateSecretRpc(secretRef: string): Promise<StoredSecret> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      validatePublicSecretRef(secretRef);
      await this.#initializeState();
      return this.#getOrCreateSecret(secretRef);
    });
  }

  /** Read an established secret under a snapshot hold without inventing missing authority. */
  async getExistingSecretRpc(secretRef: string): Promise<StoredSecret | null> {
    validateSecretRef(secretRef);
    await this.initialization;
    if (this.env.ENABLE_SAML_DR_EXPORT === 'true') await this.#assertSnapshotAuthority();
    const state =
      this.env.ENABLE_SAML_DR_EXPORT === 'true'
        ? await this.ctx.storage.get<KeyManagerState>('state')
        : this.keyManagerState;
    if (!state && this.env.ENABLE_SAML_DR_EXPORT === 'true')
      throw new Error('saml_dr_key_manager_authority_uninitialized');
    const existing = state?.secrets
      ? (Object.getOwnPropertyDescriptor(state.secrets, secretRef)?.value as
          | StoredSecret
          | undefined)
      : undefined;
    return existing ? structuredClone(existing) : null;
  }

  /**
   * Put a salt brought from another identity provider under `identifier-salt:import:<name>`
   * (the only refs this writes). The value is the salt's bytes, base64-encoded. Putting the same
   * value again changes nothing; a different value replaces the current one only when the caller
   * names the current one's fingerprint, so a salt in use is never replaced by mistake. The value
   * is never returned.
   */
  async importSecretRpc(input: {
    secretRef: string;
    value: string;
    replaceFingerprint?: string;
  }): Promise<{ fingerprint: string; outcome: 'created' | 'unchanged' | 'replaced' }> {
    // One import at a time: the first one makes the fingerprint key, and a second that began
    // before it was saved would make (and save) another, leaving the first salt's fingerprint
    // different from the one listed.
    const run = this.#importQueue.then(() => this.#importSecret(input));
    this.#importQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  #importQueue: Promise<void> = Promise.resolve();

  async #importSecret(input: {
    secretRef: string;
    value: string;
    replaceFingerprint?: string;
  }): Promise<{ fingerprint: string; outcome: 'created' | 'unchanged' | 'replaced' }> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      validateSecretRef(input.secretRef);
      if (!input.secretRef.startsWith(IMPORTED_IDENTIFIER_SALT_PREFIX)) {
        throw new Error('imported_secret_ref_not_allowed');
      }
      if (typeof input.value !== 'string' || input.value.length === 0) {
        throw new Error('imported_secret_value_invalid');
      }
      await this.#initializeState();
      const state = this.#getState();
      state.secrets ??= {};
      const existingKey = readFingerprintKey(state.secrets);
      // The fingerprint key is made here, with the import that first needs it (never by the list,
      // which is a read path of the backup): it is saved together with the import.
      const fingerprintKey: StoredSecret = existingKey ?? {
        secretRef: IDENTIFIER_SALT_FINGERPRINT_KEY_REF,
        active: this.#generateSecretVersion(),
        updatedAt: Date.now(),
      };
      const fingerprint = await saltFingerprint(fingerprintKey.active.value, input.value);
      const existing = Object.getOwnPropertyDescriptor(state.secrets, input.secretRef)?.value as
        | StoredSecret
        | undefined;
      const refs = Object.keys(state.secrets);
      if (!existing) {
        // One more secret (and the key, when it is not there yet) must still fit what a backup of
        // this key manager can carry.
        const imported = refs.filter((ref) => ref.startsWith(IMPORTED_IDENTIFIER_SALT_PREFIX));
        if (
          imported.length >= MAX_IMPORTED_SALTS ||
          refs.length + (existingKey ? 1 : 2) > MAX_PORTABLE_SECRETS
        ) {
          throw new Error('imported_secret_limit');
        }
      }
      if (existing) {
        const current = await saltFingerprint(fingerprintKey.active.value, existing.active.value);
        if (current === fingerprint) {
          if (!existingKey) await this.#storeFingerprintKey(state.secrets, fingerprintKey);
          return { fingerprint, outcome: 'unchanged' };
        }
        if (input.replaceFingerprint !== current) {
          if (!existingKey) await this.#storeFingerprintKey(state.secrets, fingerprintKey);
          throw new Error('imported_secret_replace_mismatch');
        }
      }
      const now = Date.now();
      const secret: StoredSecret = {
        secretRef: input.secretRef,
        active: { kid: `secret-${now}-${crypto.randomUUID()}`, value: input.value, createdAt: now },
        // The replaced salt is not kept: identifiers made with it are not made again.
        updatedAt: now,
      };
      const define = (ref: string, value: StoredSecret) =>
        Object.defineProperty(state.secrets, ref, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      define(input.secretRef, secret);
      if (!existingKey) define(IDENTIFIER_SALT_FINGERPRINT_KEY_REF, fingerprintKey);
      try {
        await this.#saveState();
      } catch (error) {
        // Not saved: the salt in use stays the one that is stored, here as after a restart.
        if (existing) define(input.secretRef, existing);
        else delete state.secrets[input.secretRef];
        if (!existingKey) delete state.secrets[IDENTIFIER_SALT_FINGERPRINT_KEY_REF];
        throw error;
      }
      return { fingerprint, outcome: existing ? 'replaced' : 'created' };
    });
  }

  async #storeFingerprintKey(
    secrets: Record<string, StoredSecret>,
    key: StoredSecret
  ): Promise<void> {
    Object.defineProperty(secrets, IDENTIFIER_SALT_FINGERPRINT_KEY_REF, {
      value: key,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    try {
      await this.#saveState();
    } catch (error) {
      delete secrets[IDENTIFIER_SALT_FINGERPRINT_KEY_REF];
      throw error;
    }
  }

  /**
   * HMAC-SHA-256 (hex) of each value under this key manager's own value key, with the key's id
   * (the first 16 hex of an HMAC of a fixed text under it, so records made under another key are
   * told apart). The key is made only when the caller says `create` (a tenant with no retired
   * record and no value that could be retired): a missing key with `create` unset is refused, so
   * a backup restored without its key never gets a fresh one that no record matches. It is saved
   * with the state, so a restore of the key manager carries it; it never leaves.
   */
  async identifierValueHmacsRpc(
    values: string[],
    options: { create?: boolean } = {}
  ): Promise<{ keyId: string; hmacs: string[] }> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      if (
        !Array.isArray(values) ||
        values.length > 1000 ||
        values.some((value) => typeof value !== 'string')
      ) {
        throw new Error('identifier_value_hmac_input_invalid');
      }
      await this.#initializeState();
      const state = this.#getState();
      state.secrets ??= {};
      let key = Object.getOwnPropertyDescriptor(state.secrets, IDENTIFIER_VALUE_HMAC_KEY_REF)
        ?.value as StoredSecret | undefined;
      if (!key) {
        if (options.create !== true) throw new Error('identifier_value_key_missing');
        if (Object.keys(state.secrets).length >= MAX_PORTABLE_SECRETS) {
          throw new Error('imported_secret_limit');
        }
        key = {
          secretRef: IDENTIFIER_VALUE_HMAC_KEY_REF,
          active: this.#generateSecretVersion(),
          updatedAt: Date.now(),
        };
        Object.defineProperty(state.secrets, IDENTIFIER_VALUE_HMAC_KEY_REF, {
          value: key,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        try {
          await this.#saveState();
        } catch (error) {
          delete state.secrets[IDENTIFIER_VALUE_HMAC_KEY_REF];
          throw error;
        }
      }
      const hmacKey = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(key.active.value),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const hex = (mac: ArrayBuffer) =>
        Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, '0')).join('');
      const hmacs: string[] = [];
      for (const value of values) {
        hmacs.push(hex(await crypto.subtle.sign('HMAC', hmacKey, new TextEncoder().encode(value))));
      }
      const keyId = hex(
        await crypto.subtle.sign(
          'HMAC',
          hmacKey,
          new TextEncoder().encode('authrim:identifier-value-key-id')
        )
      ).slice(0, 16);
      return { keyId, hmacs };
    });
  }

  /** The imported salts by name, with fingerprints only (never values). */
  async listImportedSecretsRpc(): Promise<
    Array<{ secretRef: string; fingerprint: string; updatedAt: number }>
  > {
    await this.initialization;
    if (this.env.ENABLE_SAML_DR_EXPORT === 'true') await this.#assertSnapshotAuthority();
    const state =
      this.env.ENABLE_SAML_DR_EXPORT === 'true'
        ? await this.ctx.storage.get<KeyManagerState>('state')
        : this.keyManagerState;
    const out: Array<{ secretRef: string; fingerprint: string; updatedAt: number }> = [];
    // Read only: the key is never made here (this is a read path of the backup). Salts without
    // their key cannot be told apart, so they are not listed with a made-up fingerprint.
    const key = readFingerprintKey(state?.secrets ?? {});
    for (const [secretRef, secret] of Object.entries(state?.secrets ?? {})) {
      if (!secretRef.startsWith(IMPORTED_IDENTIFIER_SALT_PREFIX)) continue;
      if (!key) throw new Error('imported_secret_fingerprint_key_missing');
      out.push({
        secretRef,
        fingerprint: await saltFingerprint(key.active.value, secret.active.value),
        updatedAt: secret.updatedAt,
      });
    }
    return out.sort((a, b) => a.secretRef.localeCompare(b.secretRef));
  }

  async rotateSecretRpc(secretRef: string): Promise<StoredSecret> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      validatePublicSecretRef(secretRef);
      await this.#initializeState();
      return this.#rotateSecret(secretRef);
    });
  }

  /**
   * Generate a unique key ID using cryptographically secure random
   */
  #generateKeyId(): string {
    const timestamp = Date.now();
    const random = crypto.randomUUID();
    return `key-${timestamp}-${random}`;
  }

  async #getOrCreateSecret(secretRef: string): Promise<StoredSecret> {
    validateSecretRef(secretRef);
    await this.#initializeState();

    const state = this.#getState();
    state.secrets ??= {};

    const existing = Object.getOwnPropertyDescriptor(state.secrets, secretRef)?.value as
      | StoredSecret
      | undefined;
    if (existing) {
      return existing;
    }

    if (Object.keys(state.secrets).length >= MAX_PORTABLE_SECRETS) throw new Error('secret_limit');
    const secret: StoredSecret = {
      secretRef,
      active: this.#generateSecretVersion(),
      updatedAt: Date.now(),
    };
    Object.defineProperty(state.secrets, secretRef, {
      value: secret,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    try {
      await this.#saveState();
    } catch (error) {
      delete state.secrets[secretRef];
      throw error;
    }
    return secret;
  }

  async #rotateSecret(secretRef: string): Promise<StoredSecret> {
    const current = await this.#getOrCreateSecret(secretRef);
    current.previous = current.active;
    current.active = this.#generateSecretVersion();
    current.updatedAt = Date.now();
    await this.#saveState();
    return current;
  }

  #generateSecretVersion(): StoredSecretVersion {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const value = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    return {
      kid: `secret-${Date.now()}-${crypto.randomUUID()}`,
      value,
      createdAt: Date.now(),
    };
  }

  async storeCertificateForKey(input: StoreCertificateRequest): Promise<StoredKey> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();

      const state = this.#getState();
      const key = state.keys.find((k) => k.kid === input.kid);
      if (!key) {
        throw new Error('Key not found');
      }

      if (key.certificatePEM) {
        return key;
      }

      if (
        !input.certificatePEM.startsWith('-----BEGIN CERTIFICATE-----') ||
        !input.certificatePEM.includes('-----END CERTIFICATE-----') ||
        input.certificatePEM.length > 16 * 1024
      ) {
        throw new Error('Invalid certificate PEM');
      }

      key.certificatePEM = input.certificatePEM;
      key.certificateCreatedAt = input.certificateCreatedAt ?? Date.now();
      key.certificateSha256Thumbprint = input.certificateSha256Thumbprint;

      await this.#saveState();
      return key;
    });
  }

  async importKey(input: ImportKeyRequest): Promise<StoredKey> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();

      const verifiedPublicJWK = await assertImportableSigningKey(input);
      const kid = input.kid.trim();

      const state = this.#getState();
      const status = normalizeImportedKeyStatus(input.status);
      const existing = state.keys.find((key) => key.kid === kid);
      if (existing) {
        if (existing.privatePEM !== input.privatePEM) {
          throw new Error('Imported key conflicts with existing key ID');
        }
        existing.publicJWK = verifiedPublicJWK;
        existing.status = status;
        existing.createdAt = normalizeTimestamp(input.createdAt, existing.createdAt);
        existing.certificatePEM = input.certificatePEM ?? existing.certificatePEM;
        existing.certificateCreatedAt = normalizeTimestamp(
          input.certificateCreatedAt,
          existing.certificateCreatedAt
        );
        existing.certificateSha256Thumbprint =
          input.certificateSha256Thumbprint ?? existing.certificateSha256Thumbprint;
        if (status === 'active') {
          this.#moveOtherActiveKeysToOverlap(kid);
          state.activeKeyId = kid;
        }
        await this.#saveState();
        return existing;
      }

      if (status === 'active') {
        this.#moveOtherActiveKeysToOverlap(kid);
        state.activeKeyId = kid;
      }

      const key: StoredKey = {
        kid,
        publicJWK: verifiedPublicJWK,
        privatePEM: input.privatePEM,
        createdAt: normalizeTimestamp(input.createdAt, Date.now()),
        status,
        certificatePEM: input.certificatePEM,
        certificateCreatedAt: normalizeTimestamp(input.certificateCreatedAt, undefined),
        certificateSha256Thumbprint: input.certificateSha256Thumbprint,
      };
      state.keys.push(key);
      await this.#saveState();
      return key;
    });
  }

  #moveOtherActiveKeysToOverlap(nextActiveKid: string): void {
    const state = this.#getState();
    for (const key of state.keys) {
      if (key.kid !== nextActiveKid && key.status === 'active') {
        key.status = 'overlap';
        key.expiresAt = key.expiresAt ?? Date.now() + 24 * 60 * 60 * 1000;
      }
    }
  }

  // ==========================================
  // EC Key Internal Methods (Phase 9: SD-JWT VC)
  // ==========================================

  /**
   * Generate a new EC key and add it to the key set
   *
   * @param algorithm - EC algorithm (ES256, ES384, ES512)
   */
  async generateNewECKey(algorithm: ECAlgorithm): Promise<StoredECKey> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      await this.#initializeECState();

      const kid = this.#generateECKeyId(algorithm);
      const keySet = await generateECKeySet(kid, algorithm);

      log.debug('generateNewECKey - keySet', {
        kid,
        algorithm,
        curve: keySet.curve,
        hasPEM: !!keySet.privatePEM,
        pemLength: keySet.privatePEM?.length,
      });

      const newKey: StoredECKey = {
        kid,
        algorithm,
        curve: keySet.curve,
        publicJWK: keySet.publicJWK,
        privatePEM: keySet.privatePEM,
        createdAt: Date.now(),
        status: 'overlap', // New keys start as overlap until set as active
      };

      const state = this.#getECState();
      state.keys.push(newKey);
      await this.#saveECState();

      return newKey;
    });
  }

  /**
   * Set an EC key as the active signing key for its algorithm
   */
  async setActiveECKey(kid: string): Promise<void> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      await this.#initializeECState();

      const state = this.#getECState();
      const key = state.keys.find((k) => k.kid === kid);
      // A revoked key is never made active again: its certificate chain and signatures would
      // otherwise come back with it.
      if (!key || key.status === 'revoked') {
        // SECURITY: Do not expose kid value in error to prevent key enumeration
        throw new Error('EC key not found');
      }

      const algorithm = key.algorithm;

      // Set previous active key for this algorithm to overlap status with expiry
      const previousActiveKeyId = state.activeKeyIds[algorithm];
      if (previousActiveKeyId) {
        const previousActiveKey = state.keys.find((k) => k.kid === previousActiveKeyId);
        if (previousActiveKey) {
          previousActiveKey.status = 'overlap';
          // Set expiry to 24 hours from now (overlap period)
          previousActiveKey.expiresAt = Date.now() + 24 * 60 * 60 * 1000;
        }
      }

      // Set new key as active
      key.status = 'active';
      state.activeKeyIds[algorithm] = kid;
      await this.#saveECState();
    });
  }

  /**
   * Get the active EC signing key for a specific algorithm
   */
  async getActiveECKey(algorithm: ECAlgorithm): Promise<StoredECKey | null> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      await this.#initializeECState();

      const state = this.#getECState();
      const activeKeyId = state.activeKeyIds[algorithm];
      if (!activeKeyId) {
        return null;
      }

      return state.keys.find((k) => k.kid === activeKeyId) || null;
    });
  }

  /**
   * Get all EC public keys (for JWKS endpoint)
   * Excludes revoked keys from JWKS
   */
  async getAllECPublicKeys(): Promise<JWK[]> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      await this.#initializeECState();

      const state = this.#getECState();
      // Only return active and overlap keys, exclude revoked keys
      return state.keys.filter((k) => k.status !== 'revoked').map((k) => k.publicJWK);
    });
  }

  /**
   * Rotate EC keys for a specific algorithm (generate new key and set as active)
   */
  async rotateECKeys(algorithm: ECAlgorithm): Promise<StoredECKey> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      await this.#initializeECState();

      // Every live key and every unexpired retained public key will be retained after this
      // rotation. Refuse before changing state rather than drop a key that still verifies.
      const current = this.#getECState();
      const now = Date.now();
      const retainedAfterRotation =
        (current.retiredPublicKeys ?? []).filter((r) => r.retainUntil > now).length +
        current.keys.filter((k) => k.status !== 'revoked').length;
      if (retainedAfterRotation >= MAX_RETIRED_EC_PUBLIC_KEYS) {
        throw new Error('vc_issuer_key_retention_cap_reached');
      }

      // Generate new key
      const newKey = await this.generateNewECKey(algorithm);

      // Set new key as active
      await this.setActiveECKey(newKey.kid);

      // Update last rotation timestamp
      const state = this.#getECState();
      state.lastRotation = Date.now();

      // Clean up expired EC keys
      await this.#cleanupExpiredECKeys();

      await this.#saveECState();

      // Return the key from state.keys to ensure it's the current version after cleanup
      const rotatedKey = state.keys.find((k) => k.kid === newKey.kid);
      if (!rotatedKey) {
        throw new Error('Rotated EC key not found in state after rotation');
      }

      log.debug('rotateECKeys - returning key', {
        kid: rotatedKey.kid,
        algorithm: rotatedKey.algorithm,
        hasPEM: !!rotatedKey.privatePEM,
        pemLength: rotatedKey.privatePEM?.length,
      });

      // Explicitly reconstruct the object to ensure all properties are serializable
      const result: StoredECKey = {
        kid: rotatedKey.kid,
        algorithm: rotatedKey.algorithm,
        curve: rotatedKey.curve,
        publicJWK: rotatedKey.publicJWK,
        privatePEM: rotatedKey.privatePEM,
        createdAt: rotatedKey.createdAt,
        status: rotatedKey.status,
        expiresAt: rotatedKey.expiresAt,
        revokedAt: rotatedKey.revokedAt,
        revokedReason: rotatedKey.revokedReason,
      };

      return result;
    });
  }

  /**
   * Emergency EC key rotation for key compromise scenarios
   * Immediately revokes the current active EC key and generates a new one
   *
   * @param algorithm - EC algorithm (ES256, ES384, ES512)
   * @param reason - Reason for emergency rotation (for audit purposes)
   * @returns Object with old and new key IDs
   */
  async emergencyRotateECKeys(
    algorithm: ECAlgorithm,
    reason: string
  ): Promise<{ oldKid: string; newKid: string }> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      await this.#initializeECState();

      const state = this.#getECState();
      const now = Date.now();

      // Find current active key for this algorithm
      const currentActiveKeyId = state.activeKeyIds[algorithm];
      if (!currentActiveKeyId) {
        throw new Error(`No active EC key found for algorithm ${algorithm}`);
      }

      const currentActiveKey = state.keys.find((k) => k.kid === currentActiveKeyId);
      if (!currentActiveKey) {
        // SECURITY: Do not expose kid value in error to prevent key enumeration
        throw new Error('Active EC key not found');
      }

      // Generate new key
      const newKey = await this.generateNewECKey(algorithm);
      newKey.status = 'active';

      // Immediately revoke old key (NO overlap period for security)
      currentActiveKey.status = 'revoked';
      currentActiveKey.revokedAt = now;
      currentActiveKey.revokedReason = reason;

      // A revoked key must not stay resolvable through public-key retention
      if (state.retiredPublicKeys) {
        state.retiredPublicKeys = state.retiredPublicKeys.filter(
          (r) => r.kid !== currentActiveKey.kid
        );
      }

      // Update state
      state.activeKeyIds[algorithm] = newKey.kid;
      state.lastRotation = now;
      await this.#saveECState();

      log.warn('Emergency EC rotation executed', {
        algorithm,
        oldKid: currentActiveKey.kid,
        newKid: newKey.kid,
        reason,
        timestamp: new Date(now).toISOString(),
      });

      return {
        oldKid: currentActiveKey.kid,
        newKid: newKey.kid,
      };
    });
  }

  /**
   * Clean up expired EC keys based on retention period
   */
  async #cleanupExpiredECKeys(): Promise<void> {
    const state = this.#getECState();
    const retentionMillis = state.config.retentionPeriodDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const retired = (state.retiredPublicKeys ?? []).filter((r) => r.retainUntil > now);

    state.keys = state.keys.filter((k) => {
      // Always keep active keys
      if (k.status === 'active') {
        return true;
      }

      // Remove overlap keys that have expired, keeping only the public half
      if (k.status === 'overlap' && k.expiresAt && k.expiresAt < now) {
        if (!retired.some((r) => r.kid === k.kid)) {
          retired.push({
            kid: k.kid,
            algorithm: k.algorithm,
            publicJWK: this.#publicOnlyECJWK(k.publicJWK, k.kid),
            retiredAt: now,
            retainUntil: now + RETIRED_EC_PUBLIC_KEY_RETENTION_MS,
          });
        }
        return false;
      }

      // Remove revoked keys after retention period (for audit purposes)
      if (k.status === 'revoked' && k.revokedAt) {
        const revokedAge = now - k.revokedAt;
        return revokedAge < retentionMillis;
      }

      // Keep everything else
      return true;
    });

    // Only write the field once there is something to retain, so older state shapes stay intact
    if (retired.length > 0 || state.retiredPublicKeys !== undefined) {
      state.retiredPublicKeys = retired;
    }
  }

  /** Copy only the public members of an EC JWK (never d or other private parameters). */
  #publicOnlyECJWK(jwk: JWK, kid: string): JWK {
    return { kid, kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, alg: jwk.alg, use: 'sig' };
  }

  /**
   * Generate a unique EC key ID
   */
  #generateECKeyId(algorithm: ECAlgorithm): string {
    const timestamp = Date.now();
    const random = crypto.randomUUID();
    return `ec-${algorithm.toLowerCase()}-${timestamp}-${random}`;
  }

  /**
   * Sanitize EC key data for safe HTTP response (remove private key material)
   */
  #sanitizeECKey(key: StoredECKey): Omit<StoredECKey, 'privatePEM'> {
    const { privatePEM: _privatePEM, ...safeKey } = key;
    return safeKey;
  }

  // ==========================================
  // Authentication & HTTP Handler
  // ==========================================

  /**
   * Authenticate requests using Bearer token
   *
   * @param request - The incoming HTTP request
   * @returns True if authenticated, false otherwise
   */
  #authenticate(request: Request): boolean {
    const authHeader = request.headers.get('Authorization');

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return false;
    }

    const token = authHeader.substring(7);
    const secret = this.env.KEY_MANAGER_SECRET;

    // If no secret is configured, deny all requests
    if (!secret) {
      log.error('KEY_MANAGER_SECRET is not configured');
      return false;
    }

    // Constant-time comparison to prevent timing attacks
    return timingSafeEqual(token, secret);
  }

  /**
   * Create an unauthorized response
   */
  #unauthorizedResponse(): Response {
    return new Response(
      JSON.stringify({
        error: 'Unauthorized',
        message: 'Valid authentication token required',
      }),
      {
        status: 401,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer realm="KeyManager"',
        },
      }
    );
  }

  /**
   * Sanitize key data for safe HTTP response (remove private key material)
   */
  #sanitizeKey(key: StoredKey): Omit<StoredKey, 'privatePEM'> {
    const { privatePEM: _privatePEM, ...safeKey } = key;
    return safeKey;
  }

  /**
   * Handle HTTP requests to the KeyManager Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    return runSamlDrCoveredOperation(this.env, undefined, async () => {
      await this.#initializeState();
      const url = new URL(request.url);
      const path = url.pathname;

      // Public endpoints (no authentication required)
      // /jwks is public because it only returns public keys for JWT verification
      const isPublicEndpoint = path === '/jwks' && request.method === 'GET';

      // All other endpoints require authentication (including /internal/* for security)
      if (!isPublicEndpoint && !this.#authenticate(request)) {
        return this.#unauthorizedResponse();
      }

      try {
        // GET /active - Get active signing key (public endpoints, no private key)
        if (path === '/active' && request.method === 'GET') {
          const activeKey = await this.getActiveKey();

          if (!activeKey) {
            return new Response(JSON.stringify({ error: 'No active key found' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          // Sanitize key data (remove private key material)
          const safeKey = this.#sanitizeKey(activeKey);

          return new Response(JSON.stringify(safeKey), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // GET /internal/active-with-private - Get active signing key with private key (for internal use by op-token)
        if (path === '/internal/active-with-private' && request.method === 'GET') {
          const activeKey = await this.getActiveKey();

          if (!activeKey) {
            return new Response(JSON.stringify({ error: 'No active key found' }), {
              status: 404,
              headers: { 'Content-Type': 'application/json' },
            });
          }

          // Explicitly reconstruct the object to ensure all properties are serializable
          const result: StoredKey = {
            kid: activeKey.kid,
            publicJWK: activeKey.publicJWK,
            privatePEM: activeKey.privatePEM,
            createdAt: activeKey.createdAt,
            status: activeKey.status,
            certificatePEM: activeKey.certificatePEM,
            certificateCreatedAt: activeKey.certificateCreatedAt,
            certificateSha256Thumbprint: activeKey.certificateSha256Thumbprint,
            expiresAt: activeKey.expiresAt,
            revokedAt: activeKey.revokedAt,
            revokedReason: activeKey.revokedReason,
          };

          // Return full key data including privatePEM for internal use
          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // POST /internal/certificate - Store a public certificate for an existing key once
        if (path === '/internal/certificate' && request.method === 'POST') {
          const body = await readRequestJsonWithLimit<StoreCertificateRequest>(
            request,
            MAX_KEY_MANAGER_JSON_BODY_BYTES
          );
          const key = await this.storeCertificateForKey(body);

          return new Response(JSON.stringify(this.#sanitizeKey(key)), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // POST /internal/import-key - Restore an existing RSA signing key for DR recovery
        if (path === '/internal/import-key' && request.method === 'POST') {
          const body = await readRequestJsonWithLimit<ImportKeyRequest>(
            request,
            MAX_KEY_MANAGER_JSON_BODY_BYTES
          );
          const key = await this.importKey(body);

          return new Response(JSON.stringify({ success: true, key: this.#sanitizeKey(key) }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // GET /jwks - Get all public keys (JWKS format)
        if (path === '/jwks' && request.method === 'GET') {
          const keys = await this.getAllPublicKeys();

          return new Response(JSON.stringify({ keys }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // POST /rotate - Trigger key rotation (public endpoint, no private key)
        if (path === '/rotate' && request.method === 'POST') {
          const newKey = await this.rotateKeys();

          // Sanitize key data (remove private key material)
          const safeKey = this.#sanitizeKey(newKey);

          return new Response(JSON.stringify({ success: true, key: safeKey }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // POST /internal/rotate - Trigger key rotation and return with private key (for internal use)
        if (path === '/internal/rotate' && request.method === 'POST') {
          const body = request.headers.get('Content-Type')?.includes('application/json')
            ? ((await request.json().catch(() => ({}))) as { modulusLength?: unknown })
            : {};
          const modulusLength =
            body.modulusLength === 2048 ||
            body.modulusLength === 3072 ||
            body.modulusLength === 4096
              ? body.modulusLength
              : undefined;
          const newKey = await this.rotateKeys({ modulusLength });

          log.debug('/internal/rotate - newKey', {
            kid: newKey.kid,
            modulusLength,
            hasPEM: !!newKey.privatePEM,
            pemLength: newKey.privatePEM?.length,
          });

          // Already reconstructed in rotateKeys(), so newKey should be serializable
          const responseBody = { success: true, key: newKey };
          const jsonString = JSON.stringify(responseBody);

          // Return full key data including privatePEM for internal use
          return new Response(jsonString, {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const internalSecretPath = '/internal/secrets/';
        if (path.startsWith(internalSecretPath)) {
          const secretPath = path.slice(internalSecretPath.length);
          const isSecretRotation = secretPath.endsWith('/rotate');
          const secretRefPath = isSecretRotation
            ? secretPath.slice(0, -'/rotate'.length)
            : secretPath;
          const secretRef = decodeURIComponent(secretRefPath);
          validatePublicSecretRef(secretRef);

          if (request.method === 'GET' && !isSecretRotation) {
            const secret = await this.#getOrCreateSecret(secretRef);
            return new Response(JSON.stringify(secret), {
              headers: { 'Content-Type': 'application/json' },
            });
          }

          if (request.method === 'POST' && isSecretRotation) {
            const secret = await this.#rotateSecret(secretRef);
            return new Response(JSON.stringify(secret), {
              headers: { 'Content-Type': 'application/json' },
            });
          }
        }

        const internalSecretMatch = path.match(/^\/internal\/secrets\/([^/]+)$/);
        if (internalSecretMatch && request.method === 'GET') {
          const secretRef = decodeURIComponent(internalSecretMatch[1]);
          validatePublicSecretRef(secretRef);
          const secret = await this.#getOrCreateSecret(secretRef);
          return new Response(JSON.stringify(secret), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        const internalSecretRotateMatch = path.match(/^\/internal\/secrets\/([^/]+)\/rotate$/);
        if (internalSecretRotateMatch && request.method === 'POST') {
          const secretRef = decodeURIComponent(internalSecretRotateMatch[1]);
          validatePublicSecretRef(secretRef);
          const secret = await this.#rotateSecret(secretRef);
          return new Response(JSON.stringify(secret), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // GET /should-rotate - Check if rotation is needed
        if (path === '/should-rotate' && request.method === 'GET') {
          const shouldRotate = await this.shouldRotateKeys();

          return new Response(JSON.stringify({ shouldRotate }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // GET /config - Get configuration
        if (path === '/config' && request.method === 'GET') {
          const config = await this.getConfig();

          return new Response(JSON.stringify(config), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // POST /config - Update configuration
        if (path === '/config' && request.method === 'POST') {
          const body = await readRequestJsonWithLimit<Partial<KeyRotationConfig>>(
            request,
            MAX_KEY_MANAGER_JSON_BODY_BYTES
          );
          await this.updateConfig(body);

          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // POST /emergency-rotate - Emergency key rotation (immediate revocation)
        if (path === '/emergency-rotate' && request.method === 'POST') {
          const body = await readRequestJsonWithLimit<{ reason: string }>(
            request,
            MAX_KEY_MANAGER_JSON_BODY_BYTES
          );

          if (!body.reason || body.reason.length < 10) {
            return new Response(
              JSON.stringify({
                error: 'Bad Request',
                message: 'Reason is required (minimum 10 characters)',
              }),
              {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          }

          const result = await this.emergencyRotateKeys(body.reason);

          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // GET /status - Get status of all keys (for admin dashboard)
        if (path === '/status' && request.method === 'GET') {
          await this.#initializeState();
          const state = this.#getState();

          // Sanitize keys (remove private key material)
          const keys = state.keys.map((k) => ({
            kid: k.kid,
            status: k.status,
            createdAt: k.createdAt,
            expiresAt: k.expiresAt,
            revokedAt: k.revokedAt,
            revokedReason: k.revokedReason,
          }));

          return new Response(
            JSON.stringify({
              keys,
              activeKeyId: state.activeKeyId,
              lastRotation: state.lastRotation,
            }),
            {
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        // ==========================================
        // EC Key HTTP Endpoints (Phase 9: SD-JWT VC)
        // ==========================================

        // GET /ec/active/:algorithm - Get active EC signing key
        if (path.startsWith('/ec/active/') && request.method === 'GET') {
          const algorithm = path.split('/')[3] as ECAlgorithm;
          if (!['ES256', 'ES384', 'ES512'].includes(algorithm)) {
            return new Response(
              JSON.stringify({
                error: 'Bad Request',
                message: 'Invalid algorithm. Must be ES256, ES384, or ES512',
              }),
              {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          }

          const activeKey = await this.getActiveECKey(algorithm);

          if (!activeKey) {
            return new Response(
              JSON.stringify({ error: `No active EC key found for ${algorithm}` }),
              {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          }

          // Sanitize key data (remove private key material)
          const safeKey = this.#sanitizeECKey(activeKey);

          return new Response(JSON.stringify(safeKey), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // GET /internal/ec/active-with-private/:algorithm - Get active EC key with private key
        if (path.startsWith('/internal/ec/active-with-private/') && request.method === 'GET') {
          const algorithm = path.split('/')[4] as ECAlgorithm;
          if (!['ES256', 'ES384', 'ES512'].includes(algorithm)) {
            return new Response(
              JSON.stringify({
                error: 'Bad Request',
                message: 'Invalid algorithm. Must be ES256, ES384, or ES512',
              }),
              {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          }

          const activeKey = await this.getActiveECKey(algorithm);

          if (!activeKey) {
            return new Response(
              JSON.stringify({ error: `No active EC key found for ${algorithm}` }),
              {
                status: 404,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          }

          // Return full key data including privatePEM for internal VC signing
          const result: StoredECKey = {
            kid: activeKey.kid,
            algorithm: activeKey.algorithm,
            curve: activeKey.curve,
            publicJWK: activeKey.publicJWK,
            privatePEM: activeKey.privatePEM,
            createdAt: activeKey.createdAt,
            status: activeKey.status,
            expiresAt: activeKey.expiresAt,
            revokedAt: activeKey.revokedAt,
            revokedReason: activeKey.revokedReason,
          };

          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // GET /ec/jwks - Get all EC public keys (JWKS format)
        if (path === '/ec/jwks' && request.method === 'GET') {
          const keys = await this.getAllECPublicKeys();

          return new Response(JSON.stringify({ keys }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // POST /ec/rotate/:algorithm - Rotate EC keys for a specific algorithm
        if (path.startsWith('/ec/rotate/') && request.method === 'POST') {
          const algorithm = path.split('/')[3] as ECAlgorithm;
          if (!['ES256', 'ES384', 'ES512'].includes(algorithm)) {
            return new Response(
              JSON.stringify({
                error: 'Bad Request',
                message: 'Invalid algorithm. Must be ES256, ES384, or ES512',
              }),
              {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          }

          const newKey = await this.rotateECKeys(algorithm);

          // Sanitize key data (remove private key material)
          const safeKey = this.#sanitizeECKey(newKey);

          return new Response(JSON.stringify({ success: true, key: safeKey }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // POST /internal/ec/rotate/:algorithm - Rotate EC keys and return with private key
        if (path.startsWith('/internal/ec/rotate/') && request.method === 'POST') {
          const algorithm = path.split('/')[4] as ECAlgorithm;
          if (!['ES256', 'ES384', 'ES512'].includes(algorithm)) {
            return new Response(
              JSON.stringify({
                error: 'Bad Request',
                message: 'Invalid algorithm. Must be ES256, ES384, or ES512',
              }),
              {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          }

          const newKey = await this.rotateECKeys(algorithm);

          log.debug('/internal/ec/rotate - newKey', {
            kid: newKey.kid,
            algorithm: newKey.algorithm,
            hasPEM: !!newKey.privatePEM,
            pemLength: newKey.privatePEM?.length,
          });

          // Return full key data including privatePEM for internal VC signing
          return new Response(JSON.stringify({ success: true, key: newKey }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // POST /ec/emergency-rotate/:algorithm - Emergency EC key rotation
        if (path.startsWith('/ec/emergency-rotate/') && request.method === 'POST') {
          const algorithm = path.split('/')[3] as ECAlgorithm;
          if (!['ES256', 'ES384', 'ES512'].includes(algorithm)) {
            return new Response(
              JSON.stringify({
                error: 'Bad Request',
                message: 'Invalid algorithm. Must be ES256, ES384, or ES512',
              }),
              {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          }

          const body = await readRequestJsonWithLimit<{ reason: string }>(
            request,
            MAX_KEY_MANAGER_JSON_BODY_BYTES
          );

          if (!body.reason || body.reason.length < 10) {
            return new Response(
              JSON.stringify({
                error: 'Bad Request',
                message: 'Reason is required (minimum 10 characters)',
              }),
              {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
              }
            );
          }

          const result = await this.emergencyRotateECKeys(algorithm, body.reason);

          return new Response(JSON.stringify(result), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        // GET /ec/status - Get status of all EC keys (for admin dashboard)
        if (path === '/ec/status' && request.method === 'GET') {
          await this.#initializeECState();
          const state = this.#getECState();

          // Sanitize keys (remove private key material)
          const keys = state.keys.map((k) => ({
            kid: k.kid,
            algorithm: k.algorithm,
            curve: k.curve,
            status: k.status,
            createdAt: k.createdAt,
            expiresAt: k.expiresAt,
            revokedAt: k.revokedAt,
            revokedReason: k.revokedReason,
          }));

          return new Response(
            JSON.stringify({
              keys,
              activeKeyIds: state.activeKeyIds,
              lastRotation: state.lastRotation,
            }),
            {
              headers: { 'Content-Type': 'application/json' },
            }
          );
        }

        return new Response('Not Found', { status: 404 });
      } catch (error) {
        if (error instanceof InvalidSecretRefError) {
          return new Response(JSON.stringify({ error: 'Bad Request', message: error.message }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        log.error('Request error', {}, error as Error);
        return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    });
  }
}
