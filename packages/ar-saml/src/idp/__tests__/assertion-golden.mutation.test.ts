/**
 * The exact serialisation of a SAML Success Response and Assertion, and the optional attributes
 * that change it (SessionNotOnOrAfter, SessionIndex, InResponseTo, second-level status).
 */

import { describe, expect, it } from 'vitest';
import { buildErrorResponse, buildSAMLResponse, type SAMLResponseOptions } from '../assertion';
import { STATUS_CODES } from '../../common/constants';

const OPTIONS: SAMLResponseOptions = {
  responseId: '_r1',
  assertionId: '_a1',
  issueInstant: '2024-01-15T10:30:00Z',
  issuer: 'https://idp.example.com',
  destination: 'https://sp.example.com/acs',
  inResponseTo: '_req1',
  recipientUrl: 'https://sp.example.com/acs',
  audienceRestriction: 'https://sp.example.com',
  audienceRestrictions: ['https://sp2.example.com', 'https://sp.example.com'],
  nameId: 'user@example.com',
  nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  authnInstant: '2024-01-15T10:29:00Z',
  sessionIndex: '_s1',
  notBefore: '2024-01-15T10:29:00Z',
  notOnOrAfter: '2024-01-15T10:35:00Z',
  authnContextClassRef: 'urn:oasis:names:tc:SAML:2.0:ac:classes:Password',
  attributes: [
    {
      name: 'mail',
      friendlyName: 'Mail',
      nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic',
      values: ['a@b', 'c@d'],
    },
  ],
};

const GOLDEN = `<samlp:Response ID="_r1" Version="2.0" IssueInstant="2024-01-15T10:30:00Z" Destination="https://sp.example.com/acs" InResponseTo="_req1" xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><saml:Issuer>https://idp.example.com</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status><saml:Assertion ID="_a1" Version="2.0" IssueInstant="2024-01-15T10:30:00Z"><saml:Issuer>https://idp.example.com</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">user@example.com</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="2024-01-15T10:35:00Z" Recipient="https://sp.example.com/acs" InResponseTo="_req1"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="2024-01-15T10:29:00Z" NotOnOrAfter="2024-01-15T10:35:00Z"><saml:AudienceRestriction><saml:Audience>https://sp.example.com</saml:Audience><saml:Audience>https://sp2.example.com</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="2024-01-15T10:29:00Z" SessionIndex="_s1" SessionNotOnOrAfter="2024-01-15T10:35:00Z"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="mail" FriendlyName="Mail" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic"><saml:AttributeValue xsi:type="xs:string">a@b</saml:AttributeValue><saml:AttributeValue xsi:type="xs:string">c@d</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion></samlp:Response>`;

describe('buildSAMLResponse', () => {
  it('serialises a complete Success Response exactly', () => {
    expect(buildSAMLResponse(OPTIONS)).toBe(`<?xml version="1.0" encoding="UTF-8"?>\n${GOLDEN}`);
  });

  it('defaults SessionNotOnOrAfter to NotOnOrAfter, honours an explicit value and drops it for null', () => {
    const explicit = buildSAMLResponse({ ...OPTIONS, sessionNotOnOrAfter: '2024-01-15T18:00:00Z' });
    const suppressed = buildSAMLResponse({ ...OPTIONS, sessionNotOnOrAfter: null });
    const empty = buildSAMLResponse({ ...OPTIONS, sessionNotOnOrAfter: '' });

    expect(explicit).toContain('SessionNotOnOrAfter="2024-01-15T18:00:00Z"');
    expect(explicit).not.toContain('SessionNotOnOrAfter="2024-01-15T10:35:00Z"');
    expect(suppressed).not.toContain('SessionNotOnOrAfter');
    expect(empty).not.toContain('SessionNotOnOrAfter');
  });

  it('omits SessionIndex and InResponseTo when they are absent', () => {
    const xml = buildSAMLResponse({ ...OPTIONS, sessionIndex: undefined, inResponseTo: undefined });

    expect(xml).not.toContain('SessionIndex');
    expect(xml).not.toContain('InResponseTo');
    expect(xml).toContain(
      '<saml:SubjectConfirmationData NotOnOrAfter="2024-01-15T10:35:00Z" Recipient="https://sp.example.com/acs"/>'
    );
  });

  it('does not repeat the primary audience', () => {
    const xml = buildSAMLResponse({ ...OPTIONS, audienceRestrictions: undefined });

    expect(xml.match(/<saml:Audience>/g)).toHaveLength(1);
  });

  it('builds no assertion for a non-success status and nests the second-level code', () => {
    const xml = buildSAMLResponse({
      ...OPTIONS,
      statusCode: STATUS_CODES.RESPONDER,
      secondLevelStatusCode: STATUS_CODES.NO_AUTHN_CONTEXT,
      statusMessage: 'refused',
    });

    expect(xml).not.toContain('Assertion');
    expect(xml).toContain(
      `<samlp:Status><samlp:StatusCode Value="${STATUS_CODES.RESPONDER}"><samlp:StatusCode Value="${STATUS_CODES.NO_AUTHN_CONTEXT}"/></samlp:StatusCode><samlp:StatusMessage>refused</samlp:StatusMessage></samlp:Status>`
    );
  });
});

describe('buildErrorResponse', () => {
  it('serialises an error Response without an assertion exactly', () => {
    const xml = buildErrorResponse({
      responseId: '_r2',
      issueInstant: '2024-01-15T10:30:00Z',
      issuer: 'https://idp.example.com',
      destination: 'https://sp.example.com/acs',
      inResponseTo: '_req1',
      statusCode: STATUS_CODES.REQUESTER,
    });

    expect(xml).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<samlp:Response ID="_r2" Version="2.0" IssueInstant="2024-01-15T10:30:00Z" Destination="https://sp.example.com/acs" InResponseTo="_req1" xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><saml:Issuer>https://idp.example.com</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Requester"/></samlp:Status></samlp:Response>'
    );
  });
});
