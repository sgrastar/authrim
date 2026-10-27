import { describe, expect, it } from 'vitest';
import { BINDING_URIS, SAML_NAMESPACES } from '../../common/constants';
import { findElement, getAttribute, getTextContent, parseXml } from '../../common/xml-utils';
import { buildIdPMetadata } from '../metadata';

describe('IdP metadata', () => {
  it('generates stable EntityDescriptor IDs for the same metadata inputs', () => {
    const options = {
      entityId: 'https://idp.example.com/saml/idp',
      issuerUrl: 'https://idp.example.com',
      signingCertificates: [
        {
          slot: 'active' as const,
          keyRef: 'tenant:tenant-a:saml:idp:signing',
          certificate: '-----BEGIN CERTIFICATE-----\nACTIVECERT\n-----END CERTIFICATE-----',
        },
      ],
    };

    const firstXml = buildIdPMetadata(options);
    const secondXml = buildIdPMetadata(options);
    const doc = parseXml(firstXml);
    const entityDescriptor = findElement(doc, SAML_NAMESPACES.MD, 'EntityDescriptor');

    expect(firstXml).toBe(secondXml);
    expect(getAttribute(entityDescriptor!, 'ID')).toMatch(/^_authrim_saml_idp_[a-z0-9]+$/);
    expect(getAttribute(entityDescriptor!, 'cacheDuration')).toBe('PT24H');
    expect(getAttribute(entityDescriptor!, 'validUntil')).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
  });

  it('publishes active, next, and backup signing certificates when provided', () => {
    const xml = buildIdPMetadata({
      entityId: 'https://idp.example.com/saml/idp',
      issuerUrl: 'https://idp.example.com',
      signingCertificates: [
        {
          slot: 'active',
          keyRef: 'tenant:tenant-a:saml:idp:signing',
          certificate: '-----BEGIN CERTIFICATE-----\nACTIVECERT\n-----END CERTIFICATE-----',
        },
        {
          slot: 'next',
          keyRef: 'tenant:tenant-a:saml:idp:next:signing',
          certificate: '-----BEGIN CERTIFICATE-----\nNEXTCERT\n-----END CERTIFICATE-----',
        },
        {
          slot: 'backup',
          keyRef: 'tenant:tenant-a:saml:idp:backup:signing',
          certificate: '-----BEGIN CERTIFICATE-----\nBACKUPCERT\n-----END CERTIFICATE-----',
        },
      ],
    });

    const doc = parseXml(xml);
    const descriptor = findElement(doc, SAML_NAMESPACES.MD, 'IDPSSODescriptor');
    const keyDescriptors = descriptor!.getElementsByTagNameNS(SAML_NAMESPACES.MD, 'KeyDescriptor');
    const certificates = descriptor!.getElementsByTagNameNS(SAML_NAMESPACES.DS, 'X509Certificate');

    expect(keyDescriptors.length).toBe(3);
    expect(certificates.length).toBe(3);
    expect(getTextContent(certificates[0])).toBe('ACTIVECERT');
    expect(getTextContent(certificates[1])).toBe('NEXTCERT');
    expect(getTextContent(certificates[2])).toBe('BACKUPCERT');
  });

  it('publishes POST and Redirect SingleLogoutService endpoints', () => {
    const xml = buildIdPMetadata({
      entityId: 'https://idp.example.com/saml/idp',
      issuerUrl: 'https://idp.example.com',
      signingCertificates: [
        {
          slot: 'active',
          keyRef: 'tenant:tenant-a:saml:idp:signing',
          certificate: '-----BEGIN CERTIFICATE-----\nACTIVECERT\n-----END CERTIFICATE-----',
        },
      ],
    });

    const doc = parseXml(xml);
    const descriptor = findElement(doc, SAML_NAMESPACES.MD, 'IDPSSODescriptor');
    const sloServices = Array.from(
      descriptor!.getElementsByTagNameNS(SAML_NAMESPACES.MD, 'SingleLogoutService')
    );
    const bindings = sloServices.map((service) => getAttribute(service, 'Binding'));
    const locations = sloServices.map((service) => getAttribute(service, 'Location'));

    expect(bindings).toEqual([BINDING_URIS.HTTP_POST, BINDING_URIS.HTTP_REDIRECT]);
    expect(locations).toEqual([
      'https://idp.example.com/saml/idp/slo',
      'https://idp.example.com/saml/idp/slo',
    ]);
  });

  it('omits unsupported logout endpoints for an IdP-only runtime', () => {
    const xml = buildIdPMetadata({
      entityId: 'https://idp.example.com/saml/idp',
      issuerUrl: 'https://idp.example.com',
      signingCertificates: [
        {
          slot: 'active',
          certificate: '-----BEGIN CERTIFICATE-----\nACTIVECERT\n-----END CERTIFICATE-----',
        },
      ],
      includeSLO: false,
    });

    expect(xml).not.toContain('SingleLogoutService');
    expect(xml).toContain('SingleSignOnService');
  });

  it('orders IDPSSODescriptor children according to SAML metadata schema', () => {
    const xml = buildIdPMetadata({
      entityId: 'https://idp.example.com/saml/idp',
      issuerUrl: 'https://idp.example.com',
      signingCertificates: [
        {
          slot: 'active',
          keyRef: 'tenant:tenant-a:saml:idp:signing',
          certificate: '-----BEGIN CERTIFICATE-----\nACTIVECERT\n-----END CERTIFICATE-----',
        },
      ],
    });

    const doc = parseXml(xml);
    const descriptor = findElement(doc, SAML_NAMESPACES.MD, 'IDPSSODescriptor')!;
    const childNames = Array.from(
      descriptor.childNodes as ArrayLike<{ nodeType: number; localName: string }>
    )
      .filter((node) => node.nodeType === 1)
      .map((node) => node.localName);

    expect(childNames).toEqual([
      'KeyDescriptor',
      'SingleLogoutService',
      'SingleLogoutService',
      'NameIDFormat',
      'NameIDFormat',
      'NameIDFormat',
      'NameIDFormat',
      'SingleSignOnService',
      'SingleSignOnService',
    ]);
  });

  describe('the institution of the tenant', () => {
    const base = {
      entityId: 'https://idp.example.com/saml/idp',
      issuerUrl: 'https://idp.example.com',
      signingCertificates: [
        {
          slot: 'active' as const,
          keyRef: 'tenant:tenant-a:saml:idp:signing',
          certificate: '-----BEGIN CERTIFICATE-----\nACTIVECERT\n-----END CERTIFICATE-----',
        },
      ],
    };
    const registered = {
      scopes: {
        state: 'set' as const,
        scopes: ['example.ac.jp', 'med.example.ac.jp'],
        defaultScope: 'example.ac.jp',
      },
      displayNames: { ja: '例大学', en: 'Example University' },
    };
    const names = (xml: string, element: string) =>
      Array.from(parseXml(xml).getElementsByTagNameNS(SAML_NAMESPACES.MD, element), (node) => [
        getAttribute(node, 'xml:lang'),
        getTextContent(node),
      ]);

    it('publishes each scope as a non-regular-expression shibmd:Scope in the descriptor’s Extensions', () => {
      const xml = buildIdPMetadata({ ...base, institution: registered });
      const doc = parseXml(xml);
      const descriptor = findElement(doc, SAML_NAMESPACES.MD, 'IDPSSODescriptor')!;
      const scopes = Array.from(descriptor.getElementsByTagNameNS(SAML_NAMESPACES.SHIBMD, 'Scope'));

      expect(scopes.map((scope) => getTextContent(scope))).toEqual([
        'example.ac.jp',
        'med.example.ac.jp',
      ]);
      expect(scopes.map((scope) => getAttribute(scope, 'regexp'))).toEqual(['false', 'false']);
      const extensions = (
        scopes[0] as unknown as { parentNode: { localName: string; namespaceURI: string } }
      ).parentNode;
      expect(extensions.localName).toBe('Extensions');
      expect(extensions.namespaceURI).toBe(SAML_NAMESPACES.MD);
      expect(SAML_NAMESPACES.SHIBMD).toBe('urn:mace:shibboleth:metadata:1.0');
      expect(xml).toContain('xmlns:shibmd="urn:mace:shibboleth:metadata:1.0"');
    });

    it('puts Extensions first, before the KeyDescriptor, as the schema orders it', () => {
      const doc = parseXml(buildIdPMetadata({ ...base, institution: registered }));
      const descriptor = findElement(doc, SAML_NAMESPACES.MD, 'IDPSSODescriptor')!;
      const childNames = Array.from(
        descriptor.childNodes as ArrayLike<{ nodeType: number; localName: string }>
      )
        .filter((node) => node.nodeType === 1)
        .map((node) => node.localName);

      expect(childNames.slice(0, 2)).toEqual(['Extensions', 'KeyDescriptor']);
    });

    it('names the organization in each language the tenant gave, names then display names then URLs', () => {
      const xml = buildIdPMetadata({ ...base, institution: registered });

      expect(names(xml, 'OrganizationName')).toEqual([
        ['ja', '例大学'],
        ['en', 'Example University'],
      ]);
      expect(names(xml, 'OrganizationDisplayName')).toEqual([
        ['ja', '例大学'],
        ['en', 'Example University'],
      ]);
      expect(names(xml, 'OrganizationURL')).toEqual([
        ['ja', 'https://idp.example.com'],
        ['en', 'https://idp.example.com'],
      ]);
      const organization = findElement(parseXml(xml), SAML_NAMESPACES.MD, 'Organization')!;
      expect(
        Array.from(organization.childNodes as ArrayLike<{ nodeType: number; localName: string }>)
          .filter((node) => node.nodeType === 1)
          .map((node) => node.localName)
      ).toEqual([
        'OrganizationName',
        'OrganizationName',
        'OrganizationDisplayName',
        'OrganizationDisplayName',
        'OrganizationURL',
        'OrganizationURL',
      ]);
      expect(xml).not.toContain('Authrim Identity Provider');
    });

    it('escapes what the names hold', () => {
      const xml = buildIdPMetadata({
        ...base,
        institution: {
          scopes: { state: 'unset' },
          displayNames: { ja: '例 & <大学>', en: 'A & B <University>' },
        },
      });

      expect(names(xml, 'OrganizationName')).toEqual([
        ['ja', '例 & <大学>'],
        ['en', 'A & B <University>'],
      ]);
      expect(xml).not.toContain('<University>');
    });

    it('is the metadata it always was for a tenant that set nothing', () => {
      const before = buildIdPMetadata(base);

      expect(
        buildIdPMetadata({ ...base, institution: { scopes: { state: 'unset' }, displayNames: {} } })
      ).toBe(before);
      expect(before).not.toContain('shibmd');
      expect(names(before, 'OrganizationName')).toEqual([['en', 'Authrim']]);
      expect(names(before, 'OrganizationDisplayName')).toEqual([
        ['en', 'Authrim Identity Provider'],
      ]);
    });

    it('publishes the scopes without renaming the organization, and the names without scopes', () => {
      const scopesOnly = buildIdPMetadata({
        ...base,
        institution: { scopes: registered.scopes, displayNames: {} },
      });
      expect(scopesOnly).toContain('<shibmd:Scope');
      expect(names(scopesOnly, 'OrganizationName')).toEqual([['en', 'Authrim']]);

      const namesOnly = buildIdPMetadata({
        ...base,
        institution: { scopes: { state: 'unset' }, displayNames: registered.displayNames },
      });
      expect(namesOnly).not.toContain('shibmd');
      expect(names(namesOnly, 'OrganizationName')[1]).toEqual(['en', 'Example University']);
    });

    it('publishes no scope for scopes that cannot be trusted', () => {
      const xml = buildIdPMetadata({
        ...base,
        institution: { scopes: { state: 'invalid' }, displayNames: {} },
      });

      expect(xml).not.toContain('shibmd');
    });
  });
});
