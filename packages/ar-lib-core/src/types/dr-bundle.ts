import type {
  NameIDFormat,
  SAMLAttributeReleasePolicy,
  SAMLAuthnRequestLegacyAlgorithmPolicy,
  SAMLAuthnRequestSignaturePolicy,
  SAMLBinding,
  SAMLLogoutResponseBinding,
  SAMLMetadataCertificatePublication,
  SAMLSigningCertificateSlot,
  SAMLSigningKeyPolicy,
} from './saml';

export type AuthrimDRBundleKind = 'authrim.dr_bundle.v1';
export type AuthrimDRProtocol = 'saml' | 'oidc';

export interface AuthrimDRBundle {
  kind: AuthrimDRBundleKind;
  schemaVersion: '1';
  bundleId: string;
  tenantId: string;
  generatedAt: number;
  source: AuthrimDRBundleSource;
  capabilities: Record<AuthrimDRProtocol, boolean>;
  protocols: {
    saml?: SAMLDRBundleModule;
    oidc?: OIDCDRBundleModule;
  };
  exclusions: AuthrimDRBundleExclusions;
}

export interface AuthrimDRBundleSource {
  authrimVersion?: string;
  issuer: string;
}

export interface AuthrimDRBundleExclusions {
  activeSessions: true;
  privateSigningKeys: true;
  samlTransientState: true;
  oidcTokensAndCodes: true;
}

export interface SAMLDRBundleModule {
  issuer: string;
  idp: SAMLDRIdPDescriptor;
  serviceProviders: SAMLDRServiceProvider[];
  pairwiseSubject: SAMLDRPairwiseSubjectPolicy;
  excludedState: {
    transientNameIdMappings: true;
    authnRequests: true;
    logoutRequests: true;
  };
}

export interface SAMLDRIdPDescriptor {
  entityId: string;
  ssoUrl: string;
  sloUrl?: string;
  metadataCertificatePublication: SAMLMetadataCertificatePublication;
  signingKeys: SAMLDRSigningKeyReference[];
}

export interface SAMLDRServiceProvider {
  entityId: string;
  acsUrl: string;
  acsUrls?: string[];
  sloUrl?: string;
  sloResponseUrl?: string;
  sloBinding?: Extract<SAMLBinding, 'post' | 'redirect'>;
  allowedBindings: SAMLBinding[];
  nameIdFormat: NameIDFormat;
  certificate?: string;
  signAssertions: boolean;
  signResponses: boolean;
  authnRequestSignaturePolicy?: SAMLAuthnRequestSignaturePolicy;
  logoutRequestSignaturePolicy?: SAMLAuthnRequestSignaturePolicy;
  logoutResponseSignaturePolicy?: SAMLAuthnRequestSignaturePolicy;
  logoutResponseBinding?: SAMLLogoutResponseBinding;
  acceptedAuthnRequestSignatureAlgorithms?: string[];
  acceptedAuthnRequestDigestAlgorithms?: string[];
  authnRequestLegacyAlgorithmPolicy?: SAMLAuthnRequestLegacyAlgorithmPolicy;
  signingKeyPolicy?: SAMLSigningKeyPolicy;
  attributeReleasePolicy?: SAMLAttributeReleasePolicy;
  metadataChecksumSha256?: string;
}

export interface SAMLDRSigningKeyReference {
  slot: SAMLSigningCertificateSlot;
  keyRef?: string;
  kid?: string;
  certificate: string;
  intendedUse: 'saml_signing';
}

export interface SAMLDRPairwiseSubjectPolicy {
  enabled: boolean;
  algorithm: 'sha256-base64url';
  secretRef?: string;
  rotationModel: 'active_previous';
  includesSecretValue: false;
}

export interface OIDCDRBundleModule {
  issuer: string;
  mode: 'configuration_snapshot_only';
}
