import type { SAMLIdPConfig, SAMLSPConfig } from '@authrim/ar-lib-core';
import { sha256Digest } from './step-up';

type ProviderConfig = SAMLIdPConfig | SAMLSPConfig;

export function isUnapprovedSAMLProvider(config: ProviderConfig): boolean {
  return config.trustApproval?.state === 'draft';
}

export function isMetadataSuspendedSAMLProvider(config: ProviderConfig): boolean {
  return config.metadataRefreshPolicy?.suspendedByMetadataSync === true;
}

/** Stable trust settings, excluding diagnostics, fetch clocks and the approval itself. */
export async function providerTrustConfigurationDigest(config: ProviderConfig): Promise<string> {
  const trustConfig = { ...config };
  delete trustConfig.trustApproval;
  delete trustConfig.certificateValidation;
  delete trustConfig.metadataLastFetched;
  delete trustConfig.metadataRefreshStatus;
  delete trustConfig.metadataRefreshPolicy;
  delete trustConfig.metadataXml;
  delete trustConfig.metadataHash;
  delete trustConfig.metadataCriticalFields;
  if (trustConfig.aggregateImport) {
    const { importedAt: _importedAt, verification, ...source } = trustConfig.aggregateImport;
    const {
      verifiedAt: _verifiedAt,
      warnings: _warnings,
      error: _error,
      trustProfileName: _name,
      signedElementId: _signatureId,
      ...trust
    } = verification;
    // Keep entity/source identity, the verified certificate and trust-context generation.
    // Verification clocks, labels and document signature IDs are not authorization inputs.
    return sha256Digest(
      canonicalTrustValue({ ...trustConfig, aggregateImport: { ...source, verification: trust } })
    );
  }
  return sha256Digest(canonicalTrustValue(trustConfig));
}

/** Called only after an L2 gate has accepted this exact effective configuration. */
export async function approveSAMLProviderTrust(config: ProviderConfig): Promise<void> {
  config.trustApproval = {
    state: 'approved',
    digest: await providerTrustConfigurationDigest(config),
  };
}

export async function hasApprovedSAMLProviderTrust(config: ProviderConfig): Promise<boolean> {
  return (
    config.trustApproval?.state === 'approved' &&
    config.trustApproval.digest === (await providerTrustConfigurationDigest(config))
  );
}

function canonicalTrustValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalTrustValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalTrustValue(child)])
    );
  }
  return value;
}
