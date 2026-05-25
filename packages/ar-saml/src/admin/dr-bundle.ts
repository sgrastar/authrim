import type {
  AuthrimDRBundle,
  SAMLDRSigningKeyReference,
  SAMLIdPConfig,
  SAMLSPConfig,
} from '@authrim/ar-lib-core';
import { assertDRBundleContainsNoPrivateMaterial } from '@authrim/ar-lib-core';
import { buildSAMLPairwiseSecretRef } from '../idp/subject';
import type { SAMLMetadataSigningCertificate } from '../common/saml-signing-keys';
import { requireSAMLTenantId } from '../common/tenant';

export interface BuildSAMLDRBundleInput {
  bundleId: string;
  tenantId: string;
  issuer: string;
  generatedAt: number;
  authrimVersion?: string;
  idpEntityId: string;
  idpSsoUrl: string;
  idpSloUrl?: string;
  idpSigningCertificates: SAMLMetadataSigningCertificate[];
  serviceProviders: SAMLSPConfig[];
}

export function buildSAMLDRBundle(input: BuildSAMLDRBundleInput): AuthrimDRBundle {
  const tenantId = requireSAMLTenantId(input.tenantId, 'SAML DR bundle tenant');
  const bundle: AuthrimDRBundle = {
    kind: 'authrim.dr_bundle.v1',
    schemaVersion: '1',
    bundleId: input.bundleId,
    tenantId,
    generatedAt: input.generatedAt,
    source: {
      authrimVersion: input.authrimVersion,
      issuer: input.issuer,
    },
    capabilities: {
      saml: true,
      oidc: false,
    },
    protocols: {
      saml: {
        issuer: input.issuer,
        idp: {
          entityId: input.idpEntityId,
          ssoUrl: input.idpSsoUrl,
          sloUrl: input.idpSloUrl,
          metadataCertificatePublication: 'active_next_backup',
          signingKeys: input.idpSigningCertificates.map(toDRSigningKeyReference),
        },
        serviceProviders: input.serviceProviders.map(toDRServiceProvider),
        pairwiseSubject: {
          enabled: true,
          algorithm: 'sha256-base64url',
          secretRef: buildSAMLPairwiseSecretRef(tenantId),
          rotationModel: 'active_previous',
          includesSecretValue: false,
        },
        excludedState: {
          transientNameIdMappings: true,
          authnRequests: true,
          logoutRequests: true,
        },
      },
    },
    exclusions: {
      activeSessions: true,
      privateSigningKeys: true,
      samlTransientState: true,
      oidcTokensAndCodes: true,
    },
  };

  assertDRBundleContainsNoPrivateMaterial(bundle);
  return bundle;
}

function toDRSigningKeyReference(
  certificate: SAMLMetadataSigningCertificate
): SAMLDRSigningKeyReference {
  return {
    slot: certificate.slot,
    keyRef: certificate.keyRef,
    kid: certificate.kid,
    certificate: certificate.certificate,
    intendedUse: 'saml_signing',
  };
}

function toDRServiceProvider(
  spConfig: SAMLSPConfig
): NonNullable<AuthrimDRBundle['protocols']['saml']>['serviceProviders'][number] {
  return {
    entityId: spConfig.entityId,
    acsUrl: spConfig.acsUrl,
    acsUrls: spConfig.acsUrls,
    sloUrl: spConfig.sloUrl,
    sloResponseUrl: spConfig.sloResponseUrl,
    sloBinding: spConfig.sloBinding,
    allowedBindings: spConfig.allowedBindings,
    nameIdFormat: spConfig.nameIdFormat,
    certificate: spConfig.certificate,
    signAssertions: spConfig.signAssertions,
    signResponses: spConfig.signResponses,
    authnRequestSignaturePolicy: spConfig.authnRequestSignaturePolicy,
    logoutRequestSignaturePolicy: spConfig.logoutRequestSignaturePolicy,
    logoutResponseSignaturePolicy: spConfig.logoutResponseSignaturePolicy,
    logoutResponseBinding: spConfig.logoutResponseBinding,
    acceptedAuthnRequestSignatureAlgorithms: spConfig.acceptedAuthnRequestSignatureAlgorithms,
    acceptedAuthnRequestDigestAlgorithms: spConfig.acceptedAuthnRequestDigestAlgorithms,
    authnRequestLegacyAlgorithmPolicy: spConfig.authnRequestLegacyAlgorithmPolicy,
    signingKeyPolicy: spConfig.signingKeyPolicy,
    attributeReleasePolicy: spConfig.attributeReleasePolicy,
  };
}

export function buildSAMLDRBundleFromIdPConfig(
  input: Omit<BuildSAMLDRBundleInput, 'idpEntityId' | 'idpSsoUrl' | 'idpSloUrl'> & {
    idpConfig: Pick<SAMLIdPConfig, 'entityId' | 'ssoUrl' | 'sloUrl'>;
  }
): AuthrimDRBundle {
  return buildSAMLDRBundle({
    ...input,
    idpEntityId: input.idpConfig.entityId,
    idpSsoUrl: input.idpConfig.ssoUrl,
    idpSloUrl: input.idpConfig.sloUrl,
  });
}
