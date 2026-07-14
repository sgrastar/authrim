/** Least-privilege contract exposed by ar-vc to the Management Worker. */
export interface CreateCredentialOfferServiceInput {
  tenantId: string;
  userId: string;
  credentialProfileId: string;
  credentialProfileVersion: number;
  credentialProfileSnapshotHash: string;
  credentialProfileContractSignature: string;
  credentialConfigurationId: string;
  mappingVersionId: string;
  mappingSnapshotHash: string;
  claims: Record<string, unknown>;
  claimManifest: string[];
  credentialIssuer: string;
  expiresInSeconds?: number;
  transactionCodeRequired?: boolean;
}

export interface CreateCredentialOfferServiceResult {
  offerId: string;
  credentialOfferUri: string;
  expiresAt: number;
  claimManifestHash: string;
  transactionCode?: string;
}

export interface VCIssuerServiceBinding {
  createCredentialOffer(
    input: CreateCredentialOfferServiceInput
  ): Promise<CreateCredentialOfferServiceResult>;
}
