/** Bindings of the Worker. Secrets are never `vars`. */

export interface WalletProviderEnv {
  DB: D1Database;
  /** `staging` or `production` (a `var`). */
  ENVIRONMENT: string;
  /** Issuer the wallet pins, and the wallet attestation `sub` (`vars`). */
  PROVIDER_ISSUER: string;
  WALLET_CLIENT_ID: string;
  /** Comma separated `<appIdPrefix>.<bundleId>` (a `var`). */
  APP_IDS: string;
  /** Apple's App Attest root (public): base64 DER and its SHA-256 hex (`vars`). */
  APPLE_ROOT_DER_B64: string;
  APPLE_ROOT_SHA256: string;
  MIN_BUNDLE_VERSION?: string;
  /** Comma separated bundle versions to refuse. */
  REVOKED_BUNDLE_VERSIONS?: string;
  /** Secrets: base64 of at least 32 random bytes; the previous generation is optional. */
  CHALLENGE_HMAC_KEY: string;
  CHALLENGE_HMAC_KEY_PREVIOUS?: string;
  /** Secrets: JSON `{privateKeyPkcs8, chain}` per purpose. */
  /** Public (`vars`): SHA-256 hex of the intermediate each signing chain must end at. */
  WALLET_INTERMEDIATE_SHA256?: string;
  KEY_INTERMEDIATE_SHA256?: string;
  WALLET_ATTESTATION_SIGNER?: string;
  KEY_ATTESTATION_SIGNER?: string;
}
