export type CredentialProfileLifecycleState = 'draft' | 'published' | 'disabled';

export interface CredentialProfile {
  id: string;
  tenantId: string;
  profileKey: string;
  displayName: string;
  description: string | null;
  lifecycleState: CredentialProfileLifecycleState;
  currentPublishedVersionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CredentialProfileVersion {
  id: string;
  tenantId: string;
  credentialProfileId: string;
  versionNumber: number;
  lifecycleState: 'draft' | 'published' | 'retired';
  credentialConfigurationId: string;
  issuanceFlowId: string;
  issuanceFlowVersionId: string | null;
  verificationFlowId: string | null;
  verificationFlowVersionId: string | null;
  issuanceMappingSetId: string;
  issuanceMappingVersionId: string | null;
  issuanceMappingSnapshotHash: string | null;
  verificationMappingSetId: string | null;
  verificationMappingVersionId: string | null;
  verificationMappingSnapshotHash: string | null;
  claimAllowlist: string[];
  offerTtlSeconds: number;
  maximumAttributeAgeSeconds: number;
  transactionCodeRequired: boolean;
  snapshotHash: string | null;
  publishedAt: number | null;
  createdAt: number;
  updatedAt: number;
}
