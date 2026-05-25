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
});
