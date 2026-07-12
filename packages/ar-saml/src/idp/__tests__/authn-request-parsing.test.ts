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
});

function authnRequestXml(options: {
  allowCreate?: string;
  forceAuthn?: string;
  isPassive?: string;
}): string {
  const allowCreate =
    options.allowCreate === undefined ? '' : ` AllowCreate="${options.allowCreate}"`;
  const forceAuthn = options.forceAuthn === undefined ? '' : ` ForceAuthn="${options.forceAuthn}"`;
  const isPassive = options.isPassive === undefined ? '' : ` IsPassive="${options.isPassive}"`;
  return `<samlp:AuthnRequest xmlns:samlp="${SAML_NAMESPACES.SAML2P}" xmlns:saml="${SAML_NAMESPACES.SAML2}" ID="_request123" IssueInstant="2026-07-10T00:00:00Z"${forceAuthn}${isPassive}>
    <saml:Issuer>https://sp.example.com/saml</saml:Issuer>
    <samlp:NameIDPolicy Format="${NAMEID_FORMATS.PERSISTENT}"${allowCreate}/>
  </samlp:AuthnRequest>`;
}
