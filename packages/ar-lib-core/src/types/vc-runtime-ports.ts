/**
 * Platform-neutral ports of the HAIP / administrator-credential work (design
 * `20261123-authrim-haip-aws-portability.md`, step P2).
 *
 * Types only: nothing here imports a Cloudflare type, so an AWS adapter can implement them. On
 * Cloudflare `env.VC_RUNTIME_PORTS` is absent and the services keep using their Durable Objects,
 * KV and service bindings; a runtime that sets it must provide every port a service it runs needs
 * (see `requireVcPorts` and `VC_ROUTE_PORTS`). The one-time token claims (issuance `jti`, DPoP,
 * attestation PoP) are not here: they go through the existing `AUTH_RUNTIME_PORTS.replayGuard`.
 *
 * Conventions (design section 4.6): a known refusal is returned as a value (`VcRefusal`, `null`,
 * `false`, a named result); a failure whose outcome is unknown, or an unreadable store, throws.
 * Every operation carries the tenant and never returns another tenant's data.
 */
import type { JWK } from 'jose';
import type { WalletAllowlist } from './wallet-allowlist';
import type { VCIssuerServiceBinding } from './vc-service';

/** A known refusal of a key or signing operation, returned instead of thrown. */
export interface VcRefusal {
  refused: true;
  /** For example `x5c_required`, `invalid_payload`, `vc_issuer_key_retention_cap_reached`. */
  code: string;
}

export function isVcRefusal(value: unknown): value is VcRefusal {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { refused?: unknown }).refused === true &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}

// ---------------------------------------------------------------------------------------------
// Key custody (S1) - purpose-specific signing; a raw byte signer is never exposed.
// ---------------------------------------------------------------------------------------------

export interface VcSigned {
  /** The finished compact JWS. */
  token: string;
  kid: string;
}

export interface VcSigningOptions {
  /** Refuse instead of falling back to a header without `x5c`. HAIP flows set this. */
  requireX5c?: boolean;
}

export interface VcSigningCertificateStateView {
  kid: string;
  publicJWK: JWK;
  /** The host the stored chain was validated for, or null when the key has no chain. */
  issuerHost: string | null;
  /** SHA-256 (lower-case hex) of the issuing CA that ended the stored chain, or null. */
  caSha256: string | null;
  /** The earliest `notAfter` of the stored chain (epoch ms), or null. */
  chainNotAfter: number | null;
}

export interface HaipLoginVerifierView {
  clientId: string;
  issuingCaAki: string;
  issuerHost: string;
  chainNotAfter: number;
}

export interface VcCertificateChainInput {
  kid: string;
  issuerHost: string;
  /** Base64 DER certificates, leaf first, trust anchor excluded. */
  chain: string[];
}

export interface VcCertificateChainRegistered {
  kid: string;
  leafNotAfter: number;
  chainNotAfter: number;
}

/**
 * Signing and certificate state of a tenant's VC issuer key. Rotation and revocation are not part
 * of the first AWS release (design section 4x.1) and are deliberately not on this port.
 */
export interface VcKeyCustody {
  signSdJwtIssuer(
    tenantId: string,
    payload: Record<string, unknown>,
    options?: VcSigningOptions
  ): Promise<VcSigned | VcRefusal>;
  signStatusListCredential(
    tenantId: string,
    payload: Record<string, unknown>,
    options?: VcSigningOptions
  ): Promise<VcSigned | VcRefusal>;
  /** Signs only the fixed shape of a HAIP login request object. */
  signHaipLoginRequest(
    tenantId: string,
    payload: Record<string, unknown>
  ): Promise<VcSigned | VcRefusal>;
  /** Null when the key has no usable chain (the login is not offered). */
  getHaipLoginVerifier(tenantId: string): Promise<HaipLoginVerifierView | null | VcRefusal>;
  /** Public keys that may still verify a credential: the active key and retained ones. */
  getJwks(tenantId: string): Promise<{ keys: JWK[] }>;
  /** May create the tenant's first key (as the Durable Object does today). */
  getCertificateState(tenantId: string): Promise<VcSigningCertificateStateView | VcRefusal>;
  setCertificateChain(
    tenantId: string,
    input: VcCertificateChainInput
  ): Promise<VcCertificateChainRegistered | VcRefusal>;
}

/**
 * Issues the leaf certificate of a tenant key. The caller does not pass a key or a host: the
 * implementation resolves the tenant's trusted issuer host and the public key of `kid` itself,
 * before any CA key is used.
 */
export interface VcLeafIssuer {
  issueLeaf(input: {
    tenantId: string;
    kid: string;
    /** Epoch ms the leaf must not outlive. */
    notAfter: number;
  }): Promise<{ chain: string[]; issuerHost: string } | VcRefusal>; // base64 DER, leaf first
}

// ---------------------------------------------------------------------------------------------
// Proof nonce (S3)
// ---------------------------------------------------------------------------------------------

export interface ProofNonceCreateInput {
  id: string;
  tenantId: string;
  nonceHash: string;
  createdAt: number;
  expiresAt: number;
}

export interface ProofNonceReserveInput {
  id: string;
  tenantId: string;
  nonceHash: string;
  proofFingerprint: string;
  accessTokenJti: string;
  now: number;
  leaseMs?: number;
}

export type ProofNonceReserveResult =
  | { reserved: true; reservationId: string }
  | { reserved: false; reason: 'not_found' | 'invalid_nonce' | 'replayed_proof' | 'unavailable' };

export interface ProofNonceReservationRef {
  id: string;
  tenantId: string;
  reservationId: string;
}

/** `issued -> processing -> consumed`; release and lease takeover go back to `issued`. */
export interface ProofNonceStore {
  /** `exists` for a taken id; a rejected input is a refusal; an unknown outcome throws. */
  create(input: ProofNonceCreateInput): Promise<'created' | 'exists' | VcRefusal>;
  reserve(input: ProofNonceReserveInput): Promise<ProofNonceReserveResult>;
  /** Needs the owner and the processing state only; it does not look at expiry. */
  complete(input: ProofNonceReservationRef): Promise<boolean>;
  /** Needs the owner and a nonce that has not expired. */
  release(input: ProofNonceReservationRef): Promise<boolean>;
}

// ---------------------------------------------------------------------------------------------
// Reads of the OP, the allowlist, revocation
// ---------------------------------------------------------------------------------------------

/**
 * Public signing keys of the tenant's OP (never private material). The implementation is bound to
 * the tenant AND to the current activation, and returns **only the keys that activation admits**
 * (design section 4ab.1): an older key that the OP still lists must not come back, or a token it
 * signed would still verify.
 */
export interface OpKeyReader {
  getPublicKeys(tenantId: string): Promise<JWK[]>;
}

/** What discovery, consent, the credential endpoint and the allowlist GET need. */
export interface WalletAllowlistReader {
  /**
   * A missing record is revision 0 and an empty list; an unreadable one throws. The digest the
   * administrator's approval is bound to is computed from the returned list by the caller, not
   * returned here.
   */
  get(tenantId: string): Promise<WalletAllowlist>;
}

/** What the administrator's allowlist update needs (not available on the first AWS release). */
export interface WalletAllowlistWriter {
  /** Compare-and-set against `expectedRevision`. */
  put(
    tenantId: string,
    list: WalletAllowlist,
    expectedRevision: number
  ): Promise<'stored' | 'conflict'>;
}

export type WalletAllowlistStore = WalletAllowlistReader & WalletAllowlistWriter;

export type TokenRevocationStatus = 'revoked' | 'not_revoked' | 'unknown';

/** What `ar-vc`, token exchange, introspection and UserInfo need. */
export interface TokenRevocationReader {
  /** `unknown` for anything that is not an explicit answer; never `not_revoked` by default. */
  isRevoked(input: { tenantId: string; jti: string }): Promise<TokenRevocationStatus>;
}

/** What the OP and the revoke endpoints need; the first AWS release has no writer (design 4g.1). */
export interface TokenRevocationWriter {
  /**
   * `retainUntilMs` is the last time the token could be accepted; a repeated revoke keeps the
   * maximum of the old and the new value.
   */
  revoke(input: {
    tenantId: string;
    jti: string;
    retainUntilMs: number;
    reason?: string;
  }): Promise<void>;
}

export type TokenRevocationStore = TokenRevocationReader & TokenRevocationWriter;

/**
 * The production gate of HAIP issuance and login (design sections 4z.1 and 4aa.1). HAIP is served
 * only when `state` is `on` AND `prerequisites` is `met` (the activation's eligibility binding, OP
 * revocation and consent sources, decryption check and writable admin database were verified).
 * Strongly consistent read, cached for at most 5 s; an unreadable gate throws and callers refuse.
 */
export interface VcProductionGate {
  read(tenantId: string): Promise<{
    state: 'on' | 'off';
    prerequisites: 'met' | 'missing';
    version: number;
  }>;
}

// ---------------------------------------------------------------------------------------------
// HAIP login state (S4)
// ---------------------------------------------------------------------------------------------

export type HaipLoginStateFlow = 'cross_device' | 'same_device';
export type HaipLoginStateStatus =
  | 'pending'
  | 'processing'
  | 'verified'
  | 'failed'
  | 'expired'
  | 'consumed';

export interface HaipLoginStateCreateInput {
  id: string;
  tenantId: string;
  flow: HaipLoginStateFlow;
  /** SHA-256 (base64url) of the secret the starting browser holds. */
  bindingHash: string;
  clientId: string;
  credentialIssuer: string;
  nonce: string;
  state: string;
  encryptionJwk: string;
  requestObject: string;
  /** same_device: where the wallet sends the browser next. */
  redirectUri?: string;
  createdAt: number;
  expiresAt: number;
}

export interface HaipLoginStateRecord {
  id: string;
  tenantId: string;
  flow: HaipLoginStateFlow;
  clientId: string;
  credentialIssuer: string;
  nonce: string;
  state: string;
  encryptionJwk: string;
  redirectUri?: string;
  status: HaipLoginStateStatus;
  createdAt: number;
  expiresAt: number;
}

export type HaipLoginStateReserveResult =
  | { reserved: true; reservationId: string; request: HaipLoginStateRecord }
  | { reserved: false; reason: 'not_found' | 'expired' | 'replayed' | 'unavailable' };

export interface HaipLoginStateResultInput {
  adminUserId: string;
  holderJkt: string;
  credentialId: string;
  /** SHA-256 (base64url) of the response code a same-device redirect carries. */
  responseCodeHash?: string;
}

export interface HaipLoginStateResult {
  adminUserId: string;
  holderJkt: string;
  credentialId: string;
  verifiedAt: number;
}

/**
 * The login request state machine: `pending -> processing -> verified | failed -> consumed`,
 * `pending | processing -> expired`. Every transition is one atomic conditional change.
 */
export interface HaipLoginStateStore {
  /** The store issues the shard-prefixed request id used as the encryption key id. */
  newRequestId(tenantId: string): Promise<string>;
  /** `exists` for a taken id; an invalid input (binding, redirect URI, expiry) is a refusal. */
  create(input: HaipLoginStateCreateInput): Promise<'created' | 'exists' | VcRefusal>;
  getRequestObject(input: { id: string; tenantId: string; now: number }): Promise<string | null>;
  reserveResponse(input: {
    id: string;
    tenantId: string;
    fingerprint: string;
    now: number;
  }): Promise<HaipLoginStateReserveResult>;
  complete(input: {
    id: string;
    tenantId: string;
    reservationId: string;
    result: HaipLoginStateResultInput;
    now: number;
  }): Promise<boolean>;
  fail(input: {
    id: string;
    tenantId: string;
    reservationId: string;
    errorCode: string;
  }): Promise<boolean>;
  release(input: {
    id: string;
    tenantId: string;
    reservationId: string;
    now: number;
  }): Promise<boolean>;
  getStatus(input: { id: string; tenantId: string; bindingHash: string; now: number }): Promise<{
    status: HaipLoginStateStatus;
    flow: HaipLoginStateFlow;
    expiresAt: number;
    errorCode?: string;
  } | null>;
  consume(input: {
    id: string;
    tenantId: string;
    bindingHash: string;
    responseCodeHash?: string;
    now: number;
  }): Promise<HaipLoginStateResult | null>;
}

/**
 * The three calls `ar-auth` makes to the verifier (`VCIssuerServiceBinding` today). Start-up may
 * also answer with a known refusal (no usable chain, host mismatch, `x5c_required`) as a value,
 * so that both services complete their replication write permit and `ar-auth` can answer below
 * 500 before it sets the binding cookie (design section 4y.1). The current binding returns only
 * the success value, which this type accepts.
 */
export type VerifierGateway = Pick<
  VCIssuerServiceBinding,
  'getHaipLoginStatus' | 'consumeHaipLoginResult'
> & {
  createHaipLoginRequest(
    input: Parameters<VCIssuerServiceBinding['createHaipLoginRequest']>[0]
  ): Promise<Awaited<ReturnType<VCIssuerServiceBinding['createHaipLoginRequest']>> | VcRefusal>;
};

/** What a runtime that is not Cloudflare provides; each service checks only what it needs. */
export interface VcRuntimePorts {
  keyCustody?: VcKeyCustody;
  leafIssuer?: VcLeafIssuer;
  proofNonces?: ProofNonceStore;
  opKeys?: OpKeyReader;
  /** Read side; the administrator's update also needs `walletAllowlistWriter`. */
  walletAllowlist?: WalletAllowlistReader;
  walletAllowlistWriter?: WalletAllowlistWriter;
  /** Read side; the OP and the revoke endpoints use `tokenRevocationWriter`. */
  tokenRevocation?: TokenRevocationReader;
  tokenRevocationWriter?: TokenRevocationWriter;
  productionGate?: VcProductionGate;
  haipLoginState?: HaipLoginStateStore;
  verifierGateway?: VerifierGateway;
}

export type VcPortName = keyof VcRuntimePorts;
