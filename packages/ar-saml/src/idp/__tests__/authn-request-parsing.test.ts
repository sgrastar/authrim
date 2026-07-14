import { describe, expect, it } from 'vitest';
import { NAMEID_FORMATS, SAML_NAMESPACES } from '../../common/constants';
import { parseAuthnRequestXml } from '../sso';

describe('parseAuthnRequestXml', () => {
  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ])('parses NameIDPolicy AllowCreate=%s', (allowCreate, expected) => {
    const request = parseAuthnRequestXml(authnRequestXml({ allowCreate }));

    expect(request.nameIdPolicy?.allowCreate).toBe(expected);
  });

  it('defaults AllowCreate to false when the attribute is omitted', () => {
    const request = parseAuthnRequestXml(authnRequestXml({}));

    expect(request.nameIdPolicy?.allowCreate).toBe(false);
  });

  it('parses numeric ForceAuthn and IsPassive values', () => {
    const request = parseAuthnRequestXml(
      authnRequestXml({ allowCreate: '1', forceAuthn: '1', isPassive: '0' })
    );

    expect(request.forceAuthn).toBe(true);
    expect(request.isPassive).toBe(false);
  });

  it('rejects invalid XML boolean values', () => {
    expect(() => parseAuthnRequestXml(authnRequestXml({ allowCreate: 'yes' }))).toThrow(
      'Invalid XML boolean value'
    );
  });

  it('parses destination, ACS selection, protocol binding, qualifiers, and authn context', () => {
    const request = parseAuthnRequestXml(`
      <samlp:AuthnRequest xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}"
        ID="_full" IssueInstant="2026-07-10T00:00:00Z"
        Destination="https://idp.example.test/sso"
        AssertionConsumerServiceURL="https://sp.example.test/acs"
        AssertionConsumerServiceIndex="2"
        ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
        <saml:Issuer>https://sp.example.test/entity</saml:Issuer>
        <samlp:NameIDPolicy Format="${NAMEID_FORMATS.PERSISTENT}"
          AllowCreate="true" SPNameQualifier="https://sp.example.test/entity" />
        <samlp:RequestedAuthnContext Comparison="minimum">
          <saml:AuthnContextClassRef>urn:test:loa:1</saml:AuthnContextClassRef>
          <saml:AuthnContextClassRef> urn:test:loa:2 </saml:AuthnContextClassRef>
        </samlp:RequestedAuthnContext>
      </samlp:AuthnRequest>`);

    expect(request).toMatchObject({
      id: '_full',
      issuer: 'https://sp.example.test/entity',
      destination: 'https://idp.example.test/sso',
      assertionConsumerServiceURL: 'https://sp.example.test/acs',
      assertionConsumerServiceIndex: 2,
      requestedAuthnContext: {
        comparison: 'minimum',
        authnContextClassRef: ['urn:test:loa:1', 'urn:test:loa:2'],
      },
      nameIdPolicy: {
        format: NAMEID_FORMATS.PERSISTENT,
        allowCreate: true,
        spNameQualifier: 'https://sp.example.test/entity',
      },
    });
  });

  it.each([
    ['wrong root namespace', '<AuthnRequest ID="x" IssueInstant="now"/>', 'missing AuthnRequest'],
    [
      'wrong root element',
      `<samlp:Response xmlns:samlp="${SAML_NAMESPACES.SAML2P}" ID="x" IssueInstant="now"/>`,
      'missing AuthnRequest',
    ],
    [
      'missing required attributes',
      `<samlp:AuthnRequest xmlns:samlp="${SAML_NAMESPACES.SAML2P}"/>`,
      'missing required attributes',
    ],
    [
      'missing issuer',
      `<samlp:AuthnRequest xmlns:samlp="${SAML_NAMESPACES.SAML2P}" ID="x" IssueInstant="now"/>`,
      'missing Issuer',
    ],
  ])('rejects %s', (_name, xml, message) => {
    expect(() => parseAuthnRequestXml(xml)).toThrow(message);
  });

  it.each(['-1', '1.5', 'abc', '9007199254740992'])('ignores invalid ACS index %s', (index) => {
    const request = parseAuthnRequestXml(authnRequestXml({ assertionConsumerServiceIndex: index }));
    expect(request.assertionConsumerServiceIndex).toBeUndefined();
  });

  it('omits optional policy and request values when absent', () => {
    const request = parseAuthnRequestXml(authnRequestXml({ includeNameIdPolicy: false }));
    expect(request).toMatchObject({ forceAuthn: false, isPassive: false });
    expect(request.nameIdPolicy).toBeUndefined();
    expect(request.destination).toBeUndefined();
    expect(request.assertionConsumerServiceURL).toBeUndefined();
    expect(request.requestedAuthnContext).toBeUndefined();
  });
});

function authnRequestXml(options: {
  allowCreate?: string;
  forceAuthn?: string;
  isPassive?: string;
  assertionConsumerServiceIndex?: string;
  includeNameIdPolicy?: boolean;
}): string {
  const allowCreate =
    options.allowCreate === undefined ? '' : ` AllowCreate="${options.allowCreate}"`;
  const forceAuthn = options.forceAuthn === undefined ? '' : ` ForceAuthn="${options.forceAuthn}"`;
  const isPassive = options.isPassive === undefined ? '' : ` IsPassive="${options.isPassive}"`;
  const assertionConsumerServiceIndex =
    options.assertionConsumerServiceIndex === undefined
      ? ''
      : ` AssertionConsumerServiceIndex="${options.assertionConsumerServiceIndex}"`;
  const nameIdPolicy =
    options.includeNameIdPolicy === false
      ? ''
      : `<samlp:NameIDPolicy Format="${NAMEID_FORMATS.PERSISTENT}"${allowCreate}/>`;
  return `<samlp:AuthnRequest xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}" ID="_request123" IssueInstant="2026-07-10T00:00:00Z"${forceAuthn}${isPassive}${assertionConsumerServiceIndex}>
    <saml:Issuer>https://sp.example.com/saml</saml:Issuer>
    ${nameIdPolicy}
  </samlp:AuthnRequest>`;
}
