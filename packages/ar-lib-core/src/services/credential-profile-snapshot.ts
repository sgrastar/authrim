import { canonicalMappingGraphJson } from './mapping-graph-snapshot';

export interface CredentialProfileSnapshot {
  profileId: string;
  versionNumber: number;
  credentialConfigurationId: string;
  issuanceFlowVersionId: string;
  verificationFlowVersionId: string | null;
  issuanceMappingVersionId: string;
  issuanceMappingSnapshotHash: string;
  verificationMappingVersionId: string | null;
  verificationMappingSnapshotHash: string | null;
  claimAllowlist: string[];
  offerTtlSeconds: number;
  maximumAttributeAgeSeconds: number;
  transactionCodeRequired: boolean;
}

/** Publication and schema migrations must hash the same pinned profile contract. */
export async function hashCredentialProfileSnapshot(
  value: CredentialProfileSnapshot
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalMappingGraphJson(value))
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}
