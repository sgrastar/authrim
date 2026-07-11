import type { SAMLSPConfig, SAMLSPProfile } from '@authrim/ar-lib-core';
import { DIGEST_ALGORITHMS, NAMEID_FORMATS, SIGNATURE_ALGORITHMS } from '../common/constants';

export interface SAMLSPProfileDefaults {
  signResponses: boolean;
  signAssertions: boolean;
  authnRequestSignaturePolicy: NonNullable<SAMLSPConfig['authnRequestSignaturePolicy']>;
  logoutRequestSignaturePolicy: NonNullable<SAMLSPConfig['logoutRequestSignaturePolicy']>;
  logoutResponseSignaturePolicy: NonNullable<SAMLSPConfig['logoutResponseSignaturePolicy']>;
  logoutResponseBinding: NonNullable<SAMLSPConfig['logoutResponseBinding']>;
  acceptedAuthnRequestSignatureAlgorithms: string[];
  acceptedAuthnRequestDigestAlgorithms: string[];
  nameIdFormat?: SAMLSPConfig['nameIdFormat'];
}

export const SAML_SP_PROFILE_DEFAULTS: Record<SAMLSPProfile, SAMLSPProfileDefaults> = {
  baseline: {
    signResponses: true,
    signAssertions: false,
    authnRequestSignaturePolicy: 'optional',
    logoutRequestSignaturePolicy: 'required',
    logoutResponseSignaturePolicy: 'optional',
    logoutResponseBinding: 'auto',
    acceptedAuthnRequestSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA256],
    acceptedAuthnRequestDigestAlgorithms: [DIGEST_ALGORITHMS.SHA256],
  },
  strict: {
    signResponses: true,
    signAssertions: true,
    authnRequestSignaturePolicy: 'required',
    logoutRequestSignaturePolicy: 'required',
    logoutResponseSignaturePolicy: 'required',
    logoutResponseBinding: 'auto',
    acceptedAuthnRequestSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA256],
    acceptedAuthnRequestDigestAlgorithms: [DIGEST_ALGORITHMS.SHA256],
    nameIdFormat: NAMEID_FORMATS.PERSISTENT,
  },
  academic_publisher: {
    signResponses: true,
    signAssertions: true,
    authnRequestSignaturePolicy: 'required',
    logoutRequestSignaturePolicy: 'required',
    logoutResponseSignaturePolicy: 'required',
    logoutResponseBinding: 'auto',
    acceptedAuthnRequestSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA256],
    acceptedAuthnRequestDigestAlgorithms: [DIGEST_ALGORITHMS.SHA256],
    nameIdFormat: NAMEID_FORMATS.PERSISTENT,
  },
  legacy: {
    signResponses: true,
    signAssertions: false,
    authnRequestSignaturePolicy: 'optional',
    logoutRequestSignaturePolicy: 'optional',
    logoutResponseSignaturePolicy: 'optional',
    logoutResponseBinding: 'post',
    acceptedAuthnRequestSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA256],
    acceptedAuthnRequestDigestAlgorithms: [DIGEST_ALGORITHMS.SHA256],
    nameIdFormat: NAMEID_FORMATS.EMAIL,
  },
};

export function applySAMLSPProfileDefaults(
  config: SAMLSPConfig,
  profile: SAMLSPProfile | undefined
): SAMLSPConfig {
  if (!profile) {
    return config;
  }

  const defaults = SAML_SP_PROFILE_DEFAULTS[profile];
  if (!defaults) {
    return config;
  }

  return {
    ...config,
    samlProfile: profile,
    signResponses: defaults.signResponses,
    signAssertions: defaults.signAssertions,
    authnRequestSignaturePolicy: defaults.authnRequestSignaturePolicy,
    logoutRequestSignaturePolicy: defaults.logoutRequestSignaturePolicy,
    logoutResponseSignaturePolicy: defaults.logoutResponseSignaturePolicy,
    logoutResponseBinding: defaults.logoutResponseBinding,
    acceptedAuthnRequestSignatureAlgorithms: defaults.acceptedAuthnRequestSignatureAlgorithms,
    acceptedAuthnRequestDigestAlgorithms: defaults.acceptedAuthnRequestDigestAlgorithms,
    nameIdFormat: selectSAMLSPNameIDFormat(config, defaults),
  };
}

export function selectSAMLSPNameIDFormat(
  config: Pick<SAMLSPConfig, 'nameIdFormat' | 'metadataNameIdFormats'>,
  defaults: Pick<SAMLSPProfileDefaults, 'nameIdFormat'>
): SAMLSPConfig['nameIdFormat'] {
  const advertisedFormats = config.metadataNameIdFormats ?? [];
  if (advertisedFormats.length === 0) {
    return defaults.nameIdFormat ?? config.nameIdFormat ?? NAMEID_FORMATS.EMAIL;
  }
  if (defaults.nameIdFormat && advertisedFormats.includes(defaults.nameIdFormat)) {
    return defaults.nameIdFormat;
  }
  if (advertisedFormats.includes(config.nameIdFormat)) {
    return config.nameIdFormat;
  }
  return advertisedFormats[0];
}
