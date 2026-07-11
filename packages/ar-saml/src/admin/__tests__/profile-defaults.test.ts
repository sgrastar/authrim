import { describe, expect, it } from 'vitest';
import type { SAMLSPConfig } from '@authrim/ar-lib-core';
import { DIGEST_ALGORITHMS, NAMEID_FORMATS, SIGNATURE_ALGORITHMS } from '../../common/constants';
import { applySAMLSPProfileDefaults } from '../profile-defaults';

const baseConfig: SAMLSPConfig = {
  entityId: 'https://sp.example.com/saml',
  acsUrl: 'https://sp.example.com/acs',
  certificate: '-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----',
  authnRequestSignaturePolicy: 'optional',
  nameIdFormat: NAMEID_FORMATS.EMAIL,
  attributeMapping: {},
  signAssertions: false,
  signResponses: true,
  allowedBindings: ['post'],
};

describe('SAML SP profile defaults', () => {
  it('keeps no-profile imports unchanged', () => {
    expect(applySAMLSPProfileDefaults(baseConfig, undefined)).toBe(baseConfig);
  });

  it('applies baseline defaults for compatibility-oriented SPs', () => {
    expect(applySAMLSPProfileDefaults(baseConfig, 'baseline')).toMatchObject({
      samlProfile: 'baseline',
      signResponses: true,
      signAssertions: false,
      authnRequestSignaturePolicy: 'optional',
      logoutRequestSignaturePolicy: 'required',
      logoutResponseSignaturePolicy: 'optional',
      logoutResponseBinding: 'auto',
      acceptedAuthnRequestSignatureAlgorithms: [SIGNATURE_ALGORITHMS.RSA_SHA256],
      acceptedAuthnRequestDigestAlgorithms: [DIGEST_ALGORITHMS.SHA256],
    });
  });

  it('applies strict defaults for signed request and pairwise subject deployments', () => {
    expect(applySAMLSPProfileDefaults(baseConfig, 'strict')).toMatchObject({
      samlProfile: 'strict',
      signResponses: true,
      signAssertions: true,
      authnRequestSignaturePolicy: 'required',
      logoutRequestSignaturePolicy: 'required',
      logoutResponseSignaturePolicy: 'required',
      logoutResponseBinding: 'auto',
      nameIdFormat: NAMEID_FORMATS.PERSISTENT,
    });
  });

  it('applies academic publisher defaults over imported metadata hints', () => {
    const importedConfig = {
      ...baseConfig,
      authnRequestSignaturePolicy: 'optional' as const,
      signAssertions: false,
    };

    expect(applySAMLSPProfileDefaults(importedConfig, 'academic_publisher')).toMatchObject({
      samlProfile: 'academic_publisher',
      signResponses: true,
      signAssertions: true,
      authnRequestSignaturePolicy: 'required',
      logoutRequestSignaturePolicy: 'required',
      logoutResponseSignaturePolicy: 'required',
      logoutResponseBinding: 'auto',
      nameIdFormat: NAMEID_FORMATS.PERSISTENT,
    });
  });

  it('uses POST LogoutResponse binding for legacy profile compatibility', () => {
    expect(applySAMLSPProfileDefaults(baseConfig, 'legacy')).toMatchObject({
      samlProfile: 'legacy',
      logoutResponseBinding: 'post',
      nameIdFormat: NAMEID_FORMATS.EMAIL,
    });
  });

  it('does not select a profile NameID format that metadata does not advertise', () => {
    expect(
      applySAMLSPProfileDefaults(
        {
          ...baseConfig,
          metadataNameIdFormats: [NAMEID_FORMATS.EMAIL],
        },
        'academic_publisher'
      )
    ).toMatchObject({
      nameIdFormat: NAMEID_FORMATS.EMAIL,
      metadataNameIdFormats: [NAMEID_FORMATS.EMAIL],
    });
  });

  it('selects the profile preference when metadata advertises multiple formats', () => {
    expect(
      applySAMLSPProfileDefaults(
        {
          ...baseConfig,
          metadataNameIdFormats: [NAMEID_FORMATS.EMAIL, NAMEID_FORMATS.PERSISTENT],
        },
        'academic_publisher'
      )
    ).toMatchObject({
      nameIdFormat: NAMEID_FORMATS.PERSISTENT,
    });
  });
});
