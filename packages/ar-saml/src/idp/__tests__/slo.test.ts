import type { SAMLSPConfig } from '@authrim/ar-lib-core';
import { describe, expect, it } from 'vitest';
import { NAMEID_FORMATS } from '../../common/constants';
import { resolveIdPInitiatedLogoutBinding, validateLogoutRequestNameIDQualifiers } from '../slo';

describe('IdP SLO helpers', () => {
  it('uses metadata-selected SLO binding before profile defaults', () => {
    expect(resolveIdPInitiatedLogoutBinding(spConfig({ sloBinding: 'post' }))).toBe('post');
    expect(resolveIdPInitiatedLogoutBinding(spConfig({ sloBinding: 'redirect' }))).toBe('redirect');
  });

  it('defaults legacy profile to POST and modern profiles to Redirect', () => {
    expect(resolveIdPInitiatedLogoutBinding(spConfig({ samlProfile: 'legacy' }))).toBe('post');
    expect(resolveIdPInitiatedLogoutBinding(spConfig({ samlProfile: 'strict' }))).toBe('redirect');
    expect(resolveIdPInitiatedLogoutBinding(spConfig({ samlProfile: 'academic_publisher' }))).toBe(
      'redirect'
    );
  });

  it('accepts matching LogoutRequest NameID qualifiers', () => {
    expect(
      validateLogoutRequestNameIDQualifiers(
        {
          id: '_logout',
          issueInstant: '2026-05-11T00:00:00Z',
          issuer: 'https://sp.example.test/saml/sp',
          nameId: 'user@example.test',
          nameIdNameQualifier: 'https://idp.example.test/saml/idp',
          nameIdSPNameQualifier: 'https://sp.example.test/saml/sp',
        },
        spConfig(),
        'https://idp.example.test/saml/idp'
      )
    ).toBeNull();
  });

  it('rejects mismatched LogoutRequest NameID qualifiers', () => {
    expect(
      validateLogoutRequestNameIDQualifiers(
        {
          id: '_logout',
          issueInstant: '2026-05-11T00:00:00Z',
          issuer: 'https://sp.example.test/saml/sp',
          nameId: 'user@example.test',
          nameIdSPNameQualifier: 'https://other-sp.example.test/saml/sp',
        },
        spConfig(),
        'https://idp.example.test/saml/idp'
      )
    ).toMatchObject({
      failureKind: 'logout_request_invalid_nameid_qualifier',
      policyDetails: {
        qualifier: 'SPNameQualifier',
      },
    });
  });
});

function spConfig(overrides: Partial<SAMLSPConfig> = {}): SAMLSPConfig {
  return {
    entityId: 'https://sp.example.test/saml/sp',
    acsUrl: 'https://sp.example.test/saml/acs',
    sloUrl: 'https://sp.example.test/saml/slo',
    nameIdFormat: NAMEID_FORMATS.PERSISTENT,
    attributeMapping: {},
    signAssertions: true,
    signResponses: true,
    allowedBindings: ['post'],
    ...overrides,
  };
}
