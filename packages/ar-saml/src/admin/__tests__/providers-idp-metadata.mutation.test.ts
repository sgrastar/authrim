/**
 * parseIdPMetadata: structural validation, validUntil, certificate extraction and endpoint
 * selection, pinned at the individual branches.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseIdPMetadata } from '../providers';

const MD = 'xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"';
const DS = 'xmlns:ds="http://www.w3.org/2000/09/xmldsig#"';
const PROTO = 'protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"';
const POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
const REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const SOAP = 'urn:oasis:names:tc:SAML:2.0:bindings:SOAP';

function key(certificate: string, use?: string): string {
  const useAttribute = use === undefined ? '' : ` use="${use}"`;
  return `<md:KeyDescriptor${useAttribute}><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certificate}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>`;
}

function sso(binding: string, location = 'https://idp.example.test/sso'): string {
  return `<md:SingleSignOnService Binding="${binding}" Location="${location}"/>`;
}

function slo(binding: string, location: string): string {
  return `<md:SingleLogoutService Binding="${binding}" Location="${location}"/>`;
}

function idp(inner: string, attributes = 'entityID="https://idp.example.test"'): string {
  return `<md:EntityDescriptor ${MD} ${DS} ${attributes}><md:IDPSSODescriptor ${PROTO}>${inner}</md:IDPSSODescriptor></md:EntityDescriptor>`;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('structure', () => {
  it('requires an EntityDescriptor root', () => {
    expect(() => parseIdPMetadata(`<md:Other ${MD}/>`)).toThrow(
      'Invalid metadata: missing EntityDescriptor'
    );
  });

  it('requires an entityID', () => {
    expect(() => parseIdPMetadata(idp(key('QQ==') + sso(POST), ''))).toThrow(
      'Invalid metadata: missing entityID'
    );
    expect(() => parseIdPMetadata(idp(key('QQ==') + sso(POST), 'entityID=""'))).toThrow(
      'Invalid metadata: missing entityID'
    );
  });

  it('rejects SP metadata with a role-specific message and other metadata generically', () => {
    const spOnly = `<md:EntityDescriptor ${MD} entityID="https://sp"><md:SPSSODescriptor ${PROTO}/></md:EntityDescriptor>`;
    const neither = `<md:EntityDescriptor ${MD} entityID="https://x"/>`;

    expect(() => parseIdPMetadata(spOnly)).toThrow(
      /^Metadata is for a SAML Service Provider, not an Identity Provider\. Choose Service Provider/
    );
    expect(() => parseIdPMetadata(neither)).toThrow('Invalid metadata: missing IDPSSODescriptor');
  });

  it('refuses metadata without a supported SSO binding', () => {
    expect(() => parseIdPMetadata(idp(key('QQ==') + sso(SOAP)))).toThrow(
      'Invalid metadata: no supported SSO binding found'
    );
    expect(() => parseIdPMetadata(idp(key('QQ==')))).toThrow(
      'Invalid metadata: no supported SSO binding found'
    );
  });

  it('refuses an SSO service without a Location', () => {
    expect(() =>
      parseIdPMetadata(idp(key('QQ==') + `<md:SingleSignOnService Binding="${POST}"/>`))
    ).toThrow('Invalid metadata: no supported SSO binding found');
  });
});

describe('validUntil', () => {
  const withValidUntil = (value: string) =>
    idp(key('QQ==') + sso(POST), `entityID="https://idp.example.test" validUntil="${value}"`);

  it('accepts a future validUntil and rejects one at or before now', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));

    expect(parseIdPMetadata(withValidUntil('2026-06-01T00:00:01Z')).entityId).toBe(
      'https://idp.example.test'
    );
    expect(() => parseIdPMetadata(withValidUntil('2026-06-01T00:00:00Z'))).toThrow(
      'Invalid metadata: expired validUntil'
    );
    expect(() => parseIdPMetadata(withValidUntil('2020-01-01T00:00:00Z'))).toThrow(
      'Invalid metadata: expired validUntil'
    );
  });

  it('rejects an unparsable validUntil and ignores an empty one', () => {
    expect(() => parseIdPMetadata(withValidUntil('tomorrow'))).toThrow(
      'Invalid metadata: invalid validUntil'
    );
    expect(parseIdPMetadata(withValidUntil('')).entityId).toBe('https://idp.example.test');
  });
});

describe('signing certificates', () => {
  const pem = (body: string) => `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;

  it('uses signing and unspecified-use keys, skips encryption keys, strips whitespace and de-duplicates', () => {
    const config = parseIdPMetadata(
      idp(
        key('ENC1', 'encryption') +
          key('SIGA\n  BC', 'signing') +
          key('SIGABC', 'signing') +
          key('NOUSE') +
          sso(POST)
      )
    );

    expect(config.certificates).toEqual([pem('SIGABC'), pem('NOUSE')]);
    expect(config.certificate).toBe(pem('SIGABC'));
  });

  it('requires at least one signing certificate', () => {
    expect(() => parseIdPMetadata(idp(key('ENC', 'encryption') + sso(POST)))).toThrow(
      'Invalid metadata: no signing certificate found'
    );
    expect(() => parseIdPMetadata(idp(sso(POST)))).toThrow(
      'Invalid metadata: no signing certificate found'
    );
  });
});

describe('endpoints and bindings', () => {
  it('prefers the Redirect endpoint and lists both bindings in document order', () => {
    const config = parseIdPMetadata(
      idp(
        key('K') +
          sso(POST, 'https://idp.example.test/post') +
          sso(REDIRECT, 'https://idp.example.test/redirect')
      )
    );

    expect(config.ssoUrl).toBe('https://idp.example.test/redirect');
    expect(config.allowedBindings).toEqual(['post', 'redirect']);
  });

  it('keeps the first endpoint of a binding', () => {
    const config = parseIdPMetadata(
      idp(key('K') + sso(REDIRECT, 'https://first') + sso(REDIRECT, 'https://second'))
    );

    expect(config.ssoUrl).toBe('https://first');
  });

  it('falls back to the POST endpoint when only POST is published', () => {
    const config = parseIdPMetadata(idp(key('K') + sso(POST, 'https://only-post')));

    expect(config.ssoUrl).toBe('https://only-post');
    expect(config.allowedBindings).toEqual(['post']);
  });

  it('with a POST default, picks the POST endpoint and narrows the bindings to POST', () => {
    const config = parseIdPMetadata(
      idp(key('K') + sso(REDIRECT, 'https://r') + sso(POST, 'https://p')),
      { ssoBinding: 'post', sloBinding: 'redirect', nameIdFormat: 'x' as never }
    );

    expect(config.ssoUrl).toBe('https://p');
    expect(config.allowedBindings).toEqual(['post']);
  });

  it('keeps Redirect when a POST default is set but no POST endpoint exists', () => {
    const config = parseIdPMetadata(idp(key('K') + sso(REDIRECT, 'https://r')), {
      ssoBinding: 'post',
      sloBinding: 'redirect',
      nameIdFormat: 'x' as never,
    });

    expect(config.ssoUrl).toBe('https://r');
    expect(config.allowedBindings).toEqual(['redirect']);
  });

  it('selects the logout endpoint by binding preference', () => {
    const inner =
      key('K') + sso(POST) + slo(POST, 'https://slo-post') + slo(REDIRECT, 'https://slo-redirect');

    expect(parseIdPMetadata(idp(inner)).sloUrl).toBe('https://slo-redirect');
    expect(
      parseIdPMetadata(idp(inner), {
        ssoBinding: 'redirect',
        sloBinding: 'post',
        nameIdFormat: 'x' as never,
      }).sloUrl
    ).toBe('https://slo-post');
    expect(parseIdPMetadata(idp(key('K') + sso(POST) + slo(POST, 'https://slo-post'))).sloUrl).toBe(
      'https://slo-post'
    );
    expect(parseIdPMetadata(idp(key('K') + sso(POST))).sloUrl).toBeUndefined();
    expect(
      parseIdPMetadata(idp(key('K') + sso(POST) + slo(SOAP, 'https://soap'))).sloUrl
    ).toBeUndefined();
  });
});

describe('NameID format', () => {
  const EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
  const PERSISTENT = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';

  it('uses the first published format, the tenant default, then email', () => {
    const format = (value: string) => `<md:NameIDFormat>${value}</md:NameIDFormat>`;

    expect(
      parseIdPMetadata(idp(key('K') + format(PERSISTENT) + format(EMAIL) + sso(POST))).nameIdFormat
    ).toBe(PERSISTENT);
    expect(
      parseIdPMetadata(idp(key('K') + sso(POST)), {
        ssoBinding: 'redirect',
        sloBinding: 'redirect',
        nameIdFormat: PERSISTENT,
      }).nameIdFormat
    ).toBe(PERSISTENT);
    expect(parseIdPMetadata(idp(key('K') + sso(POST))).nameIdFormat).toBe(EMAIL);
    expect(
      parseIdPMetadata(idp(key('K') + format('') + sso(POST)), {
        ssoBinding: 'redirect',
        sloBinding: 'redirect',
        nameIdFormat: PERSISTENT,
      }).nameIdFormat
    ).toBe(PERSISTENT);
  });
});
