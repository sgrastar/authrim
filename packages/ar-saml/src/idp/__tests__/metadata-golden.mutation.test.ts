/**
 * Exact documents produced by the SP and IdP metadata builders (clock fixed), plus the
 * conditional parts: Discovery Service response, encryption keys, scopes and SLO endpoints.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIdPMetadata } from '../metadata';
import { buildSPMetadata } from '../../sp/metadata';

const DECL = '<?xml version="1.0" encoding="UTF-8"?>\n';
const CERTS = [
  {
    slot: 'active' as const,
    certificate: '-----BEGIN CERTIFICATE-----\nAAAA\nBBBB\n-----END CERTIFICATE-----',
  },
  { slot: 'next' as const, certificate: 'CCCC' },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildSPMetadata', () => {
  it('serialises SP metadata with every option exactly', () => {
    expect(
      buildSPMetadata({
        entityId: 'https://t/saml/sp/metadata',
        issuerUrl: 'https://t',
        signingCertificates: CERTS,
        encryptionCertificates: ['-----BEGIN PUBLIC KEY-----\nDDDD\n-----END PUBLIC KEY-----'],
        validUntil: '2026-06-02T00:00:00Z',
        discoveryResponseLocation: 'https://t/saml/sp/login',
      })
    ).toBe(
      DECL +
        `<md:EntityDescriptor entityID="https://t/saml/sp/metadata" ID="_authrim_saml_sp_n07gx9" cacheDuration="PT24H" validUntil="2026-06-02T00:00:00Z" xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:idpdisc="urn:oasis:names:tc:SAML:profiles:SSO:idp-discovery-protocol"><md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" AuthnRequestsSigned="true" WantAssertionsSigned="true"><md:Extensions><idpdisc:DiscoveryResponse Binding="urn:oasis:names:tc:SAML:profiles:SSO:idp-discovery-protocol" Location="https://t/saml/sp/login" index="1" isDefault="true"/></md:Extensions><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>AAAABBBB</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>CCCC</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>DDDD</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat><md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat><md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:transient</md:NameIDFormat><md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified</md:NameIDFormat><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://t/saml/sp/acs" index="0" isDefault="true"/><md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://t/saml/sp/slo"/><md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://t/saml/sp/slo"/></md:SPSSODescriptor><md:Organization><md:OrganizationName xml:lang="en">Authrim</md:OrganizationName><md:OrganizationDisplayName xml:lang="en">Authrim Service Provider</md:OrganizationDisplayName><md:OrganizationURL xml:lang="en">https://t</md:OrganizationURL></md:Organization></md:EntityDescriptor>`
    );
  });

  it('serialises minimal SP metadata with the default validity exactly', () => {
    expect(
      buildSPMetadata({
        entityId: 'https://t/saml/sp/metadata',
        issuerUrl: 'https://t',
        signingCertificates: CERTS,
      })
    ).toBe(
      DECL +
        `<md:EntityDescriptor entityID="https://t/saml/sp/metadata" ID="_authrim_saml_sp_n07gx9" cacheDuration="PT24H" validUntil="2026-07-01T00:00:00Z" xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"><md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" AuthnRequestsSigned="true" WantAssertionsSigned="true"><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>AAAABBBB</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>CCCC</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat><md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat><md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:transient</md:NameIDFormat><md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified</md:NameIDFormat><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://t/saml/sp/acs" index="0" isDefault="true"/><md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://t/saml/sp/slo"/><md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://t/saml/sp/slo"/></md:SPSSODescriptor><md:Organization><md:OrganizationName xml:lang="en">Authrim</md:OrganizationName><md:OrganizationDisplayName xml:lang="en">Authrim Service Provider</md:OrganizationDisplayName><md:OrganizationURL xml:lang="en">https://t</md:OrganizationURL></md:Organization></md:EntityDescriptor>`
    );
  });
});

describe('buildIdPMetadata', () => {
  it('serialises IdP metadata without an institution exactly', () => {
    expect(
      buildIdPMetadata({
        entityId: 'https://t/saml/idp/metadata',
        issuerUrl: 'https://t',
        signingCertificates: CERTS,
        validUntil: '2026-06-02T00:00:00Z',
      })
    ).toBe(
      DECL +
        `<md:EntityDescriptor entityID="https://t/saml/idp/metadata" ID="_authrim_saml_idp_15awv07" cacheDuration="PT24H" validUntil="2026-06-02T00:00:00Z" xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" WantAuthnRequestsSigned="false"><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>AAAABBBB</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>CCCC</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://t/saml/idp/slo"/><md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://t/saml/idp/slo"/><md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat><md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat><md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:transient</md:NameIDFormat><md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified</md:NameIDFormat><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://t/saml/idp/sso"/><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://t/saml/idp/sso"/></md:IDPSSODescriptor><md:Organization><md:OrganizationName xml:lang="en">Authrim</md:OrganizationName><md:OrganizationDisplayName xml:lang="en">Authrim Identity Provider</md:OrganizationDisplayName><md:OrganizationURL xml:lang="en">https://t</md:OrganizationURL></md:Organization><md:ContactPerson contactType="technical"><md:Company>Authrim</md:Company><md:EmailAddress>support@authrim.com</md:EmailAddress></md:ContactPerson></md:EntityDescriptor>`
    );
  });

  it('publishes scopes and institution names, and leaves out SLO when the runtime has none', () => {
    expect(
      buildIdPMetadata({
        entityId: 'https://t/saml/idp/metadata',
        issuerUrl: 'https://t',
        signingCertificates: CERTS,
        includeSLO: false,
        validUntil: '2026-06-02T00:00:00Z',
        institution: {
          scopes: {
            state: 'set',
            scopes: ['example.ac.jp', 'sub.example.ac.jp'],
            defaultScope: 'example.ac.jp',
          },
          displayNames: { ja: '大学', en: 'Univ' },
        },
      })
    ).toBe(
      DECL +
        `<md:EntityDescriptor entityID="https://t/saml/idp/metadata" ID="_authrim_saml_idp_15awv07" cacheDuration="PT24H" validUntil="2026-06-02T00:00:00Z" xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" xmlns:shibmd="urn:mace:shibboleth:metadata:1.0"><md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" WantAuthnRequestsSigned="false"><md:Extensions><shibmd:Scope regexp="false">example.ac.jp</shibmd:Scope><shibmd:Scope regexp="false">sub.example.ac.jp</shibmd:Scope></md:Extensions><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>AAAABBBB</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>CCCC</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat><md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:persistent</md:NameIDFormat><md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:transient</md:NameIDFormat><md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified</md:NameIDFormat><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://t/saml/idp/sso"/><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://t/saml/idp/sso"/></md:IDPSSODescriptor><md:Organization><md:OrganizationName xml:lang="ja">大学</md:OrganizationName><md:OrganizationName xml:lang="en">Univ</md:OrganizationName><md:OrganizationDisplayName xml:lang="ja">大学</md:OrganizationDisplayName><md:OrganizationDisplayName xml:lang="en">Univ</md:OrganizationDisplayName><md:OrganizationURL xml:lang="ja">https://t</md:OrganizationURL><md:OrganizationURL xml:lang="en">https://t</md:OrganizationURL></md:Organization><md:ContactPerson contactType="technical"><md:Company>Authrim</md:Company><md:EmailAddress>support@authrim.com</md:EmailAddress></md:ContactPerson></md:EntityDescriptor>`
    );
  });

  it('ignores scopes that are not in the "set" state', () => {
    const xml = buildIdPMetadata({
      entityId: 'https://t/saml/idp/metadata',
      issuerUrl: 'https://t',
      signingCertificates: CERTS,
      institution: { scopes: { state: 'invalid' }, displayNames: {} },
    });

    expect(xml).not.toContain('shibmd');
    expect(xml).toContain('<md:OrganizationName xml:lang="en">Authrim</md:OrganizationName>');
  });
});
