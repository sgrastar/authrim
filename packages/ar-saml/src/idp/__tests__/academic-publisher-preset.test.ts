import { describe, expect, it } from 'vitest';
import { buildSAMLResponse } from '../assertion';
import { buildSAMLAttributesForSP } from '../attributes';
import {
  academicPublisherAttributeReleaseConfigFixture,
  academicPublisherSubjectFixture,
} from '../__fixtures__/academic-publisher';
import { SAML_ATTRIBUTE_NAME_FORMAT_URI } from '../attribute-presets';

describe('academic publisher SAML attribute preset', () => {
  it('releases common library publisher attributes', () => {
    const attributes = buildSAMLAttributesForSP(
      academicPublisherSubjectFixture,
      academicPublisherAttributeReleaseConfigFixture
    );

    expect(attributes).toEqual([
      {
        name: 'urn:oid:0.9.2342.19200300.100.1.3',
        friendlyName: 'mail',
        nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
        values: ['reader@example.edu'],
      },
      {
        name: 'urn:oid:2.16.840.1.113730.3.1.241',
        friendlyName: 'displayName',
        nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
        values: ['Reader Example'],
      },
      {
        name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.9',
        friendlyName: 'eduPersonScopedAffiliation',
        nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
        values: ['member@example.edu', 'staff@example.edu'],
      },
      {
        name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.7',
        friendlyName: 'eduPersonEntitlement',
        nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
        values: ['urn:mace:dir:entitlement:common-lib-terms'],
      },
    ]);
  });

  it('can build a smoke-test assertion with the preset attributes', () => {
    const attributes = buildSAMLAttributesForSP(
      academicPublisherSubjectFixture,
      academicPublisherAttributeReleaseConfigFixture
    );

    const xml = buildSAMLResponse({
      responseId: '_response123',
      assertionId: '_assertion456',
      issueInstant: '2024-01-15T10:30:00Z',
      issuer: 'https://library-a.example.org/saml/idp',
      destination: 'https://publisher.example.com/saml/acs',
      inResponseTo: '_request789',
      recipientUrl: 'https://publisher.example.com/saml/acs',
      audienceRestriction: 'https://publisher.example.com/saml/sp',
      nameId: 'user-123',
      nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
      authnInstant: '2024-01-15T10:30:00Z',
      sessionIndex: '_session123',
      notBefore: '2024-01-15T10:29:00Z',
      notOnOrAfter: '2024-01-15T10:35:00Z',
      authnContextClassRef: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
      attributes,
    });

    expect(xml).toContain('FriendlyName="mail"');
    expect(xml).toContain('FriendlyName="displayName"');
    expect(xml).toContain('FriendlyName="eduPersonScopedAffiliation"');
    expect(xml).toContain('FriendlyName="eduPersonEntitlement"');
    expect(xml).toContain('member@example.edu');
    expect(xml).toContain('urn:mace:dir:entitlement:common-lib-terms');
  });
});
