/**
 * SAML logout message builders and parsers: exact serialisation, required elements and the
 * binding encodings.
 */

import { describe, expect, it } from 'vitest';
import {
  buildLogoutRequest,
  buildLogoutResponse,
  encodeForPostBinding,
  encodeForRedirectBinding,
  encodeForRedirectBindingQueryValue,
  parseLogoutRequestPost,
  parseLogoutRequestRedirect,
  parseLogoutRequestXml,
  parseLogoutResponsePost,
  parseLogoutResponseRedirect,
  parseLogoutResponseXml,
} from '../slo-messages';

const NS =
  'xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"';
const REQUEST_OPTIONS = {
  id: '_lr1',
  issueInstant: '2026-06-01T12:00:00Z',
  issuer: 'https://idp.example.test',
  destination: 'https://sp.example.test/slo',
  nameId: 'user@example.test',
  nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress' as const,
};
const DECL = '<?xml version="1.0" encoding="UTF-8"?>\n';

describe('buildLogoutRequest', () => {
  it('serialises a minimal request exactly', () => {
    expect(buildLogoutRequest(REQUEST_OPTIONS)).toBe(
      `${DECL}<samlp:LogoutRequest ID="_lr1" Version="2.0" IssueInstant="2026-06-01T12:00:00Z" Destination="https://sp.example.test/slo" xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"><saml:Issuer>https://idp.example.test</saml:Issuer><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">user@example.test</saml:NameID></samlp:LogoutRequest>`
    );
  });

  it('adds Reason, NotOnOrAfter and SessionIndex only when given', () => {
    const xml = buildLogoutRequest({
      ...REQUEST_OPTIONS,
      reason: 'urn:oasis:names:tc:SAML:2.0:logout:user',
      notOnOrAfter: '2026-06-01T12:05:00Z',
      sessionIndex: '_s1',
    });

    expect(xml).toContain('Reason="urn:oasis:names:tc:SAML:2.0:logout:user"');
    expect(xml).toContain('NotOnOrAfter="2026-06-01T12:05:00Z"');
    expect(xml).toContain('<samlp:SessionIndex>_s1</samlp:SessionIndex>');
    const bare = buildLogoutRequest(REQUEST_OPTIONS);
    expect(bare).not.toContain('Reason');
    expect(bare).not.toContain('NotOnOrAfter');
    expect(bare).not.toContain('SessionIndex');
  });
});

describe('buildLogoutResponse', () => {
  it('serialises a success response exactly', () => {
    expect(
      buildLogoutResponse({
        id: '_resp',
        issueInstant: '2026-06-01T12:00:00Z',
        issuer: 'https://sp.example.test',
        destination: 'https://idp.example.test/slo',
        inResponseTo: '_lr1',
      })
    ).toBe(
      `${DECL}<samlp:LogoutResponse ID="_resp" Version="2.0" IssueInstant="2026-06-01T12:00:00Z" Destination="https://idp.example.test/slo" InResponseTo="_lr1" xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"><saml:Issuer>https://sp.example.test</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status></samlp:LogoutResponse>`
    );
  });

  it('carries an explicit status code and message', () => {
    const xml = buildLogoutResponse({
      id: '_resp',
      issueInstant: '2026-06-01T12:00:00Z',
      issuer: 'https://sp.example.test',
      destination: 'https://idp.example.test/slo',
      inResponseTo: '_lr1',
      statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Requester',
      statusMessage: 'denied',
    });

    expect(xml).toContain(
      '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Requester"/><samlp:StatusMessage>denied</samlp:StatusMessage></samlp:Status>'
    );
  });
});

describe('parseLogoutRequestXml', () => {
  const request = (attrs = '', body = '') =>
    `<samlp:LogoutRequest ${NS} ID="_r" IssueInstant="2026-06-01T12:00:00Z" ${attrs}><saml:Issuer>https://idp</saml:Issuer>${body}</samlp:LogoutRequest>`;
  const nameId = '<saml:NameID>u@example.test</saml:NameID>';

  it('rejects a document that is not a LogoutRequest', () => {
    expect(() =>
      parseLogoutRequestXml(`<samlp:LogoutResponse ${NS} ID="x" IssueInstant="y"/>`)
    ).toThrow('Invalid LogoutRequest: missing LogoutRequest element');
    expect(() =>
      parseLogoutRequestXml('<samlp:LogoutRequest xmlns:samlp="urn:evil" ID="x" IssueInstant="y"/>')
    ).toThrow('Invalid LogoutRequest: missing LogoutRequest element');
  });

  it.each([
    ['ID', `<samlp:LogoutRequest ${NS} IssueInstant="y"/>`],
    ['IssueInstant', `<samlp:LogoutRequest ${NS} ID="x"/>`],
  ])('requires %s', (_label, xml) => {
    expect(() => parseLogoutRequestXml(xml)).toThrow(
      'Invalid LogoutRequest: missing required attributes'
    );
  });

  it('requires an Issuer and a NameID', () => {
    expect(() =>
      parseLogoutRequestXml(
        `<samlp:LogoutRequest ${NS} ID="_r" IssueInstant="y"><saml:NameID>u</saml:NameID></samlp:LogoutRequest>`
      )
    ).toThrow('Invalid LogoutRequest: missing Issuer');
    expect(() => parseLogoutRequestXml(request())).toThrow('Invalid LogoutRequest: missing NameID');
  });

  it('reads every field and collects all SessionIndex values, first one as sessionIndex', () => {
    const parsed = parseLogoutRequestXml(
      request(
        'Destination="https://d" NotOnOrAfter="2026-06-01T12:05:00Z"',
        `<saml:NameID Format="urn:f" NameQualifier="https://nq" SPNameQualifier="https://spnq">u@example.test</saml:NameID><samlp:SessionIndex>s1</samlp:SessionIndex><samlp:SessionIndex></samlp:SessionIndex><samlp:SessionIndex>s2</samlp:SessionIndex>`
      )
    );

    expect(parsed).toEqual({
      id: '_r',
      issueInstant: '2026-06-01T12:00:00Z',
      issuer: 'https://idp',
      destination: 'https://d',
      nameId: 'u@example.test',
      nameIdFormat: 'urn:f',
      nameIdNameQualifier: 'https://nq',
      nameIdSPNameQualifier: 'https://spnq',
      sessionIndex: 's1',
      sessionIndices: ['s1', 's2'],
      notOnOrAfter: '2026-06-01T12:05:00Z',
    });
  });

  it('leaves optional fields undefined when absent and keeps an empty NameID as an empty string', () => {
    const parsed = parseLogoutRequestXml(request('', '<saml:NameID/>'));

    expect(parsed.nameId).toBe('');
    expect(parsed.nameIdFormat).toBeUndefined();
    expect(parsed.sessionIndex).toBeUndefined();
    expect(parsed.sessionIndices).toBeUndefined();
    expect(parsed.destination).toBeUndefined();
    expect(parsed.notOnOrAfter).toBeUndefined();
  });

  it('ignores Issuer, NameID and SessionIndex elements that are not direct children', () => {
    expect(() =>
      parseLogoutRequestXml(
        `<samlp:LogoutRequest ${NS} ID="_r" IssueInstant="y"><samlp:Extensions><saml:Issuer>x</saml:Issuer></samlp:Extensions>${nameId}</samlp:LogoutRequest>`
      )
    ).toThrow('Invalid LogoutRequest: missing Issuer');
    const parsed = parseLogoutRequestXml(
      request(
        '',
        `${nameId}<samlp:Extensions><samlp:SessionIndex>nested</samlp:SessionIndex></samlp:Extensions>`
      )
    );
    expect(parsed.sessionIndices).toBeUndefined();
  });
});

describe('parseLogoutResponseXml', () => {
  const response = (
    attrs = '',
    status = '<samlp:Status><samlp:StatusCode Value="urn:s"/></samlp:Status>'
  ) =>
    `<samlp:LogoutResponse ${NS} ID="_p" IssueInstant="2026-06-01T12:00:00Z" ${attrs}><saml:Issuer>https://sp</saml:Issuer>${status}</samlp:LogoutResponse>`;

  it('rejects a document that is not a LogoutResponse', () => {
    expect(() =>
      parseLogoutResponseXml(`<samlp:LogoutRequest ${NS} ID="x" IssueInstant="y"/>`)
    ).toThrow('Invalid LogoutResponse: missing LogoutResponse element');
    expect(() =>
      parseLogoutResponseXml(
        '<samlp:LogoutResponse xmlns:samlp="urn:evil" ID="x" IssueInstant="y"/>'
      )
    ).toThrow('Invalid LogoutResponse: missing LogoutResponse element');
  });

  it.each([
    ['ID', `<samlp:LogoutResponse ${NS} IssueInstant="y"/>`],
    ['IssueInstant', `<samlp:LogoutResponse ${NS} ID="x"/>`],
  ])('requires %s', (_label, xml) => {
    expect(() => parseLogoutResponseXml(xml)).toThrow(
      'Invalid LogoutResponse: missing required attributes'
    );
  });

  it('requires an Issuer, a Status and a StatusCode', () => {
    expect(() =>
      parseLogoutResponseXml(`<samlp:LogoutResponse ${NS} ID="_p" IssueInstant="y"/>`)
    ).toThrow('Invalid LogoutResponse: missing Issuer');
    expect(() => parseLogoutResponseXml(response('', ''))).toThrow(
      'Invalid LogoutResponse: missing Status'
    );
    expect(() => parseLogoutResponseXml(response('', '<samlp:Status/>'))).toThrow(
      'Invalid LogoutResponse: missing StatusCode'
    );
  });

  it('reads every field', () => {
    const parsed = parseLogoutResponseXml(
      response(
        'Destination="https://d" InResponseTo="_r"',
        '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/><samlp:StatusMessage>fine</samlp:StatusMessage></samlp:Status>'
      )
    );

    expect(parsed).toEqual({
      id: '_p',
      issueInstant: '2026-06-01T12:00:00Z',
      issuer: 'https://sp',
      destination: 'https://d',
      inResponseTo: '_r',
      statusCode: 'urn:oasis:names:tc:SAML:2.0:status:Success',
      statusMessage: 'fine',
    });
  });

  it('defaults an absent status value to an empty string and leaves empty optionals undefined', () => {
    const parsed = parseLogoutResponseXml(
      response('', '<samlp:Status><samlp:StatusCode/><samlp:StatusMessage/></samlp:Status>')
    );

    expect(parsed.statusCode).toBe('');
    expect(parsed.statusMessage).toBeUndefined();
    expect(parsed.destination).toBeUndefined();
    expect(parsed.inResponseTo).toBeUndefined();
  });

  it('reads a StatusCode only from the direct child Status', () => {
    expect(() =>
      parseLogoutResponseXml(
        response(
          '',
          '<samlp:Status><samlp:Extensions><samlp:StatusCode Value="x"/></samlp:Extensions></samlp:Status>'
        )
      )
    ).toThrow('Invalid LogoutResponse: missing StatusCode');
  });
});

describe('binding encodings', () => {
  const requestXml = buildLogoutRequest(REQUEST_OPTIONS);
  const responseXml = buildLogoutResponse({
    id: '_resp',
    issueInstant: '2026-06-01T12:00:00Z',
    issuer: 'https://sp.example.test',
    destination: 'https://idp.example.test/slo',
    inResponseTo: '_lr1',
  });

  it('round-trips through the POST binding', () => {
    expect(parseLogoutRequestPost(encodeForPostBinding(requestXml)).id).toBe('_lr1');
    expect(parseLogoutResponsePost(encodeForPostBinding(responseXml)).inResponseTo).toBe('_lr1');
  });

  it('round-trips through the redirect binding value form', () => {
    expect(parseLogoutRequestRedirect(encodeForRedirectBindingQueryValue(requestXml)).issuer).toBe(
      'https://idp.example.test'
    );
    expect(parseLogoutResponseRedirect(encodeForRedirectBindingQueryValue(responseXml)).id).toBe(
      '_resp'
    );
  });

  it('produces the URL-safe unpadded form for the redirect binding', () => {
    const encoded = encodeForRedirectBinding(`${requestXml}${'?>>>~~~'.repeat(20)}`);

    expect(encoded).not.toMatch(/[+/=]/);
    const standard = encodeForRedirectBindingQueryValue(`${requestXml}${'?>>>~~~'.repeat(20)}`);
    expect(encoded).toBe(standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
    expect(standard).toMatch(/[+/=]/);
  });

  it('keeps "=" inside the base64 text of the unpadded form untouched', () => {
    expect(encodeForRedirectBinding('x')).not.toMatch(/=$/);
    expect(encodeForRedirectBinding(requestXml).length).toBeGreaterThan(10);
  });
});
