/**
 * Platform-neutral ports of the Authrim-operated Keyring wallet provider (design
 * `20261125-authrim-wallet-provider-service.md`, section 6).
 *
 * Types only: nothing here imports a Cloudflare type, so a DynamoDB / KMS adapter (stage W4) can
 * implement them and run the same contract tests as the D1 adapter. Conventions follow
 * `vc-runtime-ports.ts`: a known refusal is a returned value, an unreadable store or an outcome
 * that cannot be known throws.
 */

/** A public P-256 JWK as it goes into a provider JWT. */
export interface WalletProviderJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

/** What the registry keeps per App Attest key. Values from the verified attestation only. */
export interface DeviceRecord {
  /** App Attest key id, standard base64 of 32 bytes. */
  keyId: string;
  publicKeyJwk: WalletProviderJwk;
  counter: number;
  environment: 'development' | 'production';
  validationCategory?: number;
  bundleVersion?: string;
  /** SHA-256 (lower-case hex) of the App ID that the key was attested for. */
  appIdHash: string;
  /** SHA-256 hex of the decoded attestation object and of the challenge string. */
  attestationSha256: string;
  challengeSha256: string;
  /** Base64 receipt as received (not verified in v1). */
  receipt: string;
  lastBundleVersion?: string;
  lastValidationCategory?: number;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
  revokeReason?: string;
}

export interface DeviceRegistry {
  /**
   * Atomically inserts the device and claims its challenge. `same`: the key is registered with the
   * same attestation and challenge hashes; `conflict`: registered with anything else;
   * `challenge_used`: another key claimed this challenge.
   */
  register(record: DeviceRecord): Promise<'created' | 'same' | 'conflict' | 'challenge_used'>;
  /** Revoked records are returned with `revokedAt`. */
  get(keyId: string): Promise<DeviceRecord | null>;
  /**
   * One conditional update: the counter moves only if `next` is greater and the key is not revoked.
   * The latest verified build info is stored with it.
   */
  advanceCounter(
    keyId: string,
    next: number,
    seen: { bundleVersion?: string; validationCategory?: number },
    at: number
  ): Promise<'advanced' | 'not_greater' | 'revoked' | 'unknown'>;
  /** An unknown key creates nothing; a repeat keeps the first time and reason. */
  revoke(keyId: string, reason: string, at: number): Promise<'revoked' | 'already' | 'unknown'>;
  /**
   * Operator use only. Filters use the last verified build info. Returns the number revoked.
   * A failure in the middle may leave some devices revoked: it is safe to run again (devices
   * already revoked keep their first time and reason and are not counted).
   */
  revokeWhere(
    filter: {
      lastBundleVersionLt?: string;
      lastValidationCategory?: number;
      createdBefore?: number;
      includeUnknownBuild?: boolean;
    },
    reason: string,
    at: number
  ): Promise<number>;
  /** Best effort. */
  touch(keyId: string, at: number): Promise<void>;
}

export interface WalletAttestationSigningClaims {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  cnf: { jwk: WalletProviderJwk };
}

export interface KeyAttestationSigningClaims {
  iat: number;
  exp: number;
  nonce: string;
  attested_keys: [WalletProviderJwk];
  key_storage: string[];
}

export type ProviderSignResult = { jwt: string } | { refused: true; code: string };

/** Purpose-specific: there is no raw `sign(bytes)`. Implementations validate the exact claim shape. */
export interface ProviderSigner {
  signWalletAttestation(claims: WalletAttestationSigningClaims): Promise<ProviderSignResult>;
  signKeyAttestation(claims: KeyAttestationSigningClaims): Promise<ProviderSignResult>;
  /** Public data only. `0` means that purpose cannot sign now. Epoch seconds of the earliest notAfter. */
  health(): Promise<{ chainNotAfter: { wallet: number; key: number } }>;
}

/**
 * Fixed-window counters. A window starts at its first `check`; `peek` reads the same verdict
 * without counting. `maxRequests: 0` makes a one-shot lock: `peek` is allowed only while no live
 * window exists.
 */
export interface WalletProviderRateLimiter {
  /** Counts one request in a fixed window and tells whether it is within `maxRequests`. */
  check(input: {
    key: string;
    windowSeconds: number;
    maxRequests: number;
  }): Promise<{ allowed: boolean; remaining: number; resetAt: number }>;
  /** Reads without counting. */
  peek(input: {
    key: string;
    windowSeconds: number;
    maxRequests: number;
  }): Promise<{ allowed: boolean; remaining: number; resetAt: number }>;
}

export interface WalletProviderPorts {
  registry: DeviceRegistry;
  signer: ProviderSigner;
  rateLimiter: WalletProviderRateLimiter;
}
