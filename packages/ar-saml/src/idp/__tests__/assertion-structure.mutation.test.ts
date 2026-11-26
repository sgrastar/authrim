/**
 * Exact structure of the Response/Assertion XML built by buildSAMLResponse: namespace prefixes,
 * default attribute NameFormat, persistent NameID attribute values and the error-response shape.
 */

import { describe, expect, it } from 'vitest';
import { buildErrorResponse, buildSAMLResponse, type SAMLResponseOptions } from '../assertion';
import { SAML_NAMESPACES, STATUS_CODES } from '../../common/constants';
import { parseXml, findElement, findElements } from '../../common/xml-utils';

const BASE: SAMLResponseOptions = {
  responseId: '_resp',
  assertionId: '_assert',
  issueInstant: '2024-01-15T10:30:00Z',
  issuer: 'https://idp.example.com',
  destination: 'https://sp.example.com/acs',
  recipientUrl: 'https://sp.example.com/acs',
  audienceRestriction: 'https://sp.example.com',
  nameId: 'user@example.com',
  nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  authnInstant: '2024-01-15T10:29:00Z',
  notBefore: '2024-01-15T10:29:00Z',
  notOnOrAfter: '2024-01-15T10:35:00Z',
  authnContextClassRef: 'urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport',
};

function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('expected a value');
  }
  return value;
}

function first(parent: unknown, localName: string, namespace: string = SAML_NAMESPACES.SAML2) {
  return findElement(parent, namespace, localName) as Element | null;
}

function all(xml: string, localName: string): Element[] {
  return findElements(parseXml(xml), SAML_NAMESPACES.SAML2, localName) as Element[];
}

function attributeValues(xml: string): Element[] {
  return all(xml, 'AttributeValue');
}

describe('protocol structure', () => {
  it('prefixes protocol elements with samlp and assertion elements with saml', () => {
    const xml = buildSAMLResponse({ ...BASE, statusMessage: 'ok' });

    expect(xml).toContain('<samlp:Response ');
    expect(xml).toContain('<samlp:Status>');
    expect(xml).toContain('<samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"');
    expect(xml).toContain('<samlp:StatusMessage>ok</samlp:StatusMessage>');
    expect(xml).toContain('<saml:Assertion ');
  });

  it('nests the second-level status code inside the top-level one', () => {
    const xml = buildErrorResponse({
      responseId: '_r',
      issueInstant: '2024-01-15T10:30:00Z',
      issuer: 'https://idp.example.com',
      destination: 'https://sp.example.com/acs',
      statusCode: STATUS_CODES.REQUESTER,
      secondLevelStatusCode: STATUS_CODES.AUTHN_FAILED,
      statusMessage: 'denied',
    });

    const doc = parseXml(xml);
    const status = must(first(doc, 'Status', SAML_NAMESPACES.SAML2P));
    const outer = must(first(status, 'StatusCode', SAML_NAMESPACES.SAML2P));
    const inner = must(first(outer, 'StatusCode', SAML_NAMESPACES.SAML2P));
    expect(outer.getAttribute('Value')).toBe(STATUS_CODES.REQUESTER);
    expect(inner.getAttribute('Value')).toBe(STATUS_CODES.AUTHN_FAILED);
    expect(first(doc, 'Assertion')).toBeNull();
    expect(xml).toContain('<samlp:StatusMessage>denied</samlp:StatusMessage>');
  });
});

describe('error response input', () => {
  it('refuses the Success status code instead of building an empty-id Assertion', () => {
    expect(() =>
      buildErrorResponse({
        responseId: '_r',
        issueInstant: '2024-01-15T10:30:00Z',
        issuer: 'https://idp.example.com',
        destination: 'https://sp.example.com/acs',
        statusCode: STATUS_CODES.SUCCESS,
      })
    ).toThrow('buildErrorResponse cannot build a Success status response');
  });
});

describe('attribute statements', () => {
  it('defaults the attribute NameFormat to the URI format and keeps an explicit one', () => {
    const xml = buildSAMLResponse({
      ...BASE,
      attributes: [
        { name: 'a', values: ['1'] },
        {
          name: 'b',
          nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:basic',
          values: ['2'],
        },
      ],
    });

    expect(all(xml, 'Attribute').map((a) => a.getAttribute('NameFormat'))).toEqual([
      'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
      'urn:oasis:names:tc:SAML:2.0:attrname-format:basic',
    ]);
  });

  it('omits the AttributeStatement when the attribute list is empty', () => {
    const xml = buildSAMLResponse({ ...BASE, attributes: [] });

    expect(xml).not.toContain('AttributeStatement');
  });

  it('types values as xs:string by default and honors an explicit valueType', () => {
    const xml = buildSAMLResponse({
      ...BASE,
      attributes: [
        { name: 'a', values: ['x'] },
        { name: 'b', valueType: 'xs:boolean', values: ['true'] },
      ],
    });

    const values = attributeValues(xml);
    expect(values.map((v) => v.getAttributeNS(SAML_NAMESPACES.XSI, 'type'))).toEqual([
      'xs:string',
      'xs:boolean',
    ]);
    expect(values.map((v) => v.textContent)).toEqual(['x', 'true']);
  });

  it('emits a persistent NameID element for a well-formed "name-qualifier!sp-qualifier!id" value', () => {
    const xml = buildSAMLResponse({
      ...BASE,
      attributes: [
        {
          name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.10',
          valueType: 'saml:persistent-nameid',
          values: ['https://idp.example.com!https://sp.example.com!opaque-id'],
        },
      ],
    });

    const [value] = attributeValues(xml);
    const nameId = must(first(must(value), 'NameID'));
    expect(nameId.getAttribute('Format')).toBe(
      'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent'
    );
    expect(nameId.getAttribute('NameQualifier')).toBe('https://idp.example.com');
    expect(nameId.getAttribute('SPNameQualifier')).toBe('https://sp.example.com');
    expect(nameId.textContent).toBe('opaque-id');
    expect(must(value).getAttributeNS(SAML_NAMESPACES.XSI, 'type')).toBe('');
    expect(must(value).textContent).toBe('opaque-id');
  });

  it.each([
    ['too few parts', 'a!b'],
    ['too many parts', 'a!b!c!d'],
    ['an empty first part', '!b!c'],
    ['an empty middle part', 'a!!c'],
    ['an empty last part', 'a!b!'],
  ])('falls back to a plain typed value for a persistent NameID with %s', (_label, raw) => {
    const xml = buildSAMLResponse({
      ...BASE,
      attributes: [{ name: 'p', valueType: 'saml:persistent-nameid', values: [raw] }],
    });

    const [value] = attributeValues(xml);
    expect(first(must(value), 'NameID')).toBeNull();
    expect(must(value).textContent).toBe(raw);
    expect(must(value).getAttributeNS(SAML_NAMESPACES.XSI, 'type')).toBe('saml:persistent-nameid');
  });

  it('does not treat a value as a persistent NameID unless the attribute asks for it', () => {
    const xml = buildSAMLResponse({
      ...BASE,
      attributes: [{ name: 'p', values: ['a!b!c'] }],
    });

    const [value] = attributeValues(xml);
    expect(first(must(value), 'NameID')).toBeNull();
    expect(must(value).textContent).toBe('a!b!c');
  });
});
