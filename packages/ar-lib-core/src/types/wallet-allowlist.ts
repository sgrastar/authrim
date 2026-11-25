/**
 * The data of the tenant's wallet allowlist, free of every platform type (no `Env`, no KV): the
 * ports in `vc-runtime-ports` and the Cloudflare reader both use it.
 */

export interface WalletAttestationAnchor {
  /** Base64 DER of the root (or other trust anchor) certificate. */
  certificate: string;
  /** Lower-case hex SHA-256 of that DER, checked against the certificate when loading. */
  sha256: string;
  /** Human label for the audit log and the allowlist UI. */
  label?: string;
}

export interface WalletAllowlistEntry {
  /** The wallet type's identifier: the attestation `sub` and the OAuth `client_id`. */
  clientId: string;
  label: string;
  enabled: boolean;
  /** Roots a client attestation's chain may end at. */
  attestationRoots: WalletAttestationAnchor[];
  /**
   * Lower-case hex SHA-256 of leaf certificates a client attestation may be signed with. When
   * set, the attestation's leaf must be one of them as well as chain to a root, so a root that
   * issues certificates to other parties does not vouch for all of them. Empty: roots only.
   */
  attestationLeafSha256: string[];
  /** Roots a key attestation's chain may end at (used by the credential endpoint, S3). */
  keyAttestationRoots: WalletAttestationAnchor[];
  /** Redirect URIs the wallet may use (https app links or a registered custom scheme). */
  redirectUris: string[];
}

export interface WalletAllowlist {
  version: 1;
  /** Epoch ms of the last change. */
  updatedAt: number;
  /** Counts changes; an update names the revision it was made against. */
  revision: number;
  entries: WalletAllowlistEntry[];
}
