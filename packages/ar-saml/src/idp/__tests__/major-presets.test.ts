import { describe, expect, it } from 'vitest';
import { buildSAMLResponse } from '../assertion';
import { buildSAMLAttributesForSP } from '../attributes';
import {
  buildIdentityMappingConfig,
  enterpriseSaaSAttributeReleaseConfigFixture,
  enterpriseSaaSSubjectFixture,
  researchFederationAttributeReleaseConfigFixture,
  researchFederationSubjectFixture,
} from '../__fixtures__/major-presets';
import { SAML_ATTRIBUTE_NAME_FORMAT_URI } from '../attribute-presets';

describe('major SAML attribute presets', () => {
  it('releases common enterprise SaaS workforce attributes', () => {
    const attributes = buildSAMLAttributesForSP(
      enterpriseSaaSSubjectFixture,
      enterpriseSaaSAttributeReleaseConfigFixture
    );

    expect(attributes).toEqual([
      {
        name: 'urn:oid:0.9.2342.19200300.100.1.3',
        friendlyName: 'mail',
        nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
        values: ['employee@example.com'],
      },
      {
        name: 'urn:oid:2.16.840.1.113730.3.1.241',
        friendlyName: 'displayName',
        nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
        values: ['Employee Example'],
      },
      {
        name: 'urn:oid:2.5.4.42',
        friendlyName: 'givenName',
        nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
        values: ['Employee'],
      },
      {
        name: 'urn:oid:2.5.4.4',
        friendlyName: 'sn',
        nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
        values: ['Example'],
      },
      {
        name: 'urn:oid:1.2.840.113556.1.2.102',
        friendlyName: 'memberOf',
        nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
        values: ['finance', 'workspace-admins'],
      },
    ]);
  });

  it('allows enterprise SaaS group attribute aliases per SP', () => {
    const attributes = buildSAMLAttributesForSP(enterpriseSaaSSubjectFixture, {
      attributeMapping: {},
      identityMapping: buildIdentityMappingConfig([
        ['groups', 'authrim.custom_claims', 'groups', 'Groups', 'Groups'],
      ]),
    });

    expect(attributes.at(-1)).toEqual({
      name: 'Groups',
      friendlyName: 'Groups',
      nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
      values: ['finance', 'workspace-admins'],
    });
  });

  it('releases common research federation collaboration attributes', () => {
    const attributes = buildSAMLAttributesForSP(
      researchFederationSubjectFixture,
      researchFederationAttributeReleaseConfigFixture
    );

    expect(attributes).toEqual([
      {
        name: 'urn:oid:0.9.2342.19200300.100.1.3',
        friendlyName: 'mail',
        nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
        values: ['researcher@example.edu'],
      },
      {
        name: 'urn:oid:2.16.840.1.113730.3.1.241',
        friendlyName: 'displayName',
        nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
        values: ['Researcher Example'],
      },
      {
        name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.6',
        friendlyName: 'eduPersonPrincipalName',
        nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
        values: ['researcher@example.edu'],
      },
      {
        name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.9',
        friendlyName: 'eduPersonScopedAffiliation',
        nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
        values: ['faculty@example.edu', 'member@example.edu'],
      },
      {
        name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.7',
        friendlyName: 'eduPersonEntitlement',
        nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
        values: ['urn:mace:example.edu:entitlement:research-platform'],
      },
      {
        name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.13',
        friendlyName: 'eduPersonUniqueId',
        nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
        values: ['researcher-789@example.edu'],
      },
    ]);
  });

  it('can build smoke-test assertions for both additional presets', () => {
    const enterpriseXml = buildSAMLResponse({
      ...baseResponseOptions,
      attributes: buildSAMLAttributesForSP(
        enterpriseSaaSSubjectFixture,
        enterpriseSaaSAttributeReleaseConfigFixture
      ),
    });
    const researchXml = buildSAMLResponse({
      ...baseResponseOptions,
      responseId: '_response_research',
      assertionId: '_assertion_research',
      attributes: buildSAMLAttributesForSP(
        researchFederationSubjectFixture,
        researchFederationAttributeReleaseConfigFixture
      ),
    });

    expect(enterpriseXml).toContain('FriendlyName="memberOf"');
    expect(enterpriseXml).toContain('workspace-admins');
    expect(researchXml).toContain('FriendlyName="eduPersonPrincipalName"');
    expect(researchXml).toContain('researcher-789@example.edu');
  });
});

const baseResponseOptions = {
  responseId: '_response_enterprise',
  assertionId: '_assertion_enterprise',
  issueInstant: '2024-01-15T10:30:00Z',
  issuer: 'https://tenant.example.com/saml/idp',
  destination: 'https://sp.example.com/saml/acs',
  inResponseTo: '_request123',
  recipientUrl: 'https://sp.example.com/saml/acs',
  audienceRestriction: 'https://sp.example.com/saml/sp',
  nameId: 'user-456',
  nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent' as const,
  authnInstant: '2024-01-15T10:30:00Z',
  sessionIndex: '_session123',
  notBefore: '2024-01-15T10:29:00Z',
  notOnOrAfter: '2024-01-15T10:35:00Z',
  authnContextClassRef: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
};
