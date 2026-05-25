import { describe, expect, it } from 'vitest';
import { buildSAMLResponse } from '../assertion';

describe('SAML assertion attributes', () => {
  const baseOptions = {
    responseId: '_response123',
    assertionId: '_assertion456',
    issueInstant: '2024-01-15T10:30:00Z',
    issuer: 'https://idp.example.com',
    destination: 'https://sp.example.com/acs',
    inResponseTo: '_request789',
    recipientUrl: 'https://sp.example.com/acs',
    audienceRestriction: 'https://sp.example.com',
    nameId: 'user@example.com',
    nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' as const,
    authnInstant: '2024-01-15T10:30:00Z',
    sessionIndex: '_session123',
    notBefore: '2024-01-15T10:29:00Z',
    notOnOrAfter: '2024-01-15T10:35:00Z',
    authnContextClassRef: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
  };

  it('emits FriendlyName and NameFormat when attribute metadata is provided', () => {
    const xml = buildSAMLResponse({
      ...baseOptions,
      attributes: [
        {
          name: 'urn:oid:0.9.2342.19200300.100.1.3',
          nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
          friendlyName: 'mail',
          values: ['user@example.com'],
        },
      ],
    });

    expect(xml).toContain('Name="urn:oid:0.9.2342.19200300.100.1.3"');
    expect(xml).toContain('FriendlyName="mail"');
    expect(xml).toContain('NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:uri"');
  });
});
