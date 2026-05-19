import { describe, expect, it } from 'vitest';
import { syntheticSPMetadataFixtures } from '../../common/__fixtures__/metadata';
import { SAML_NAMESPACES } from '../../common/constants';
import { SAML_INTEROPERABILITY_MATRIX } from '../../common/interoperability-matrix';
import { findElement, getAttribute, parseXml } from '../../common/xml-utils';
import { buildIdPMetadata } from '../../idp/metadata';
import { buildSPMetadata } from '../../sp/metadata';
import { handlePreviewMetadata, parseIdPMetadata, parseSPMetadata } from '../providers';

describe('SAML metadata interoperability fixtures', () => {
  it.each(syntheticSPMetadataFixtures)('imports $id metadata', ({ metadataXml, expected }) => {
    const config = parseSPMetadata(metadataXml);

    expect(config.entityId).toBe(expected.entityId);
    expect(config.acsUrl).toBe(expected.acsUrl);
    expect(config.acsUrls).toEqual([...expected.acsUrls]);
    if ('acsServices' in expected) {
      expect(config.acsServices).toEqual([...expected.acsServices]);
    }
    expect(config.sloUrl).toBe(expected.sloUrl);
    if ('sloResponseUrl' in expected) {
      expect(config.sloResponseUrl).toBe(expected.sloResponseUrl);
    }
    if ('sloBinding' in expected) {
      expect(config.sloBinding).toBe(expected.sloBinding);
    }
    expect(config.authnRequestSignaturePolicy).toBe(expected.authnRequestSignaturePolicy);
    expect(config.signAssertions).toBe(expected.signAssertions);
    expect(config.signResponses).toBe(expected.signResponses);
    expect(config.nameIdFormat).toBe(expected.nameIdFormat);
    expect(config.allowedBindings).toEqual([...expected.allowedBindings]);
    if ('metadataRequestedAttributeCount' in expected) {
      expect(config.metadataRequestedAttributes).toHaveLength(
        expected.metadataRequestedAttributeCount
      );
    }
    if ('metadataSuggestedAttributeCount' in expected) {
      expect(config.metadataAttributeReleasePolicySuggestion?.attributes).toHaveLength(
        expected.metadataSuggestedAttributeCount
      );
    }

    if (expected.hasCertificate) {
      expect(config.certificate).toContain('BEGIN CERTIFICATE');
    } else {
      expect(config.certificate).toBeUndefined();
    }
  });

  it('keeps all covered matrix entries connected to CI tests', () => {
    const coveredEntries = SAML_INTEROPERABILITY_MATRIX.filter(
      (entry) => entry.status === 'covered'
    );

    expect(coveredEntries.length).toBeGreaterThan(0);
    expect(coveredEntries.every((entry) => entry.ciTest)).toBe(true);
  });

  it('roundtrips Authrim SP metadata export through metadata import parser', () => {
    const xml = buildSPMetadata({
      entityId: 'https://tenant.example.com/saml/sp',
      issuerUrl: 'https://tenant.example.com',
      signingCertificates: [
        {
          slot: 'active',
          certificate: '-----BEGIN CERTIFICATE-----\nSPCERT\n-----END CERTIFICATE-----',
        },
      ],
    });

    const config = parseSPMetadata(xml);

    expect(config.entityId).toBe('https://tenant.example.com/saml/sp');
    expect(config.acsUrl).toBe('https://tenant.example.com/saml/sp/acs');
    expect(config.acsUrls).toEqual(['https://tenant.example.com/saml/sp/acs']);
    expect(config.sloUrl).toBe('https://tenant.example.com/saml/sp/slo');
    expect(config.sloResponseUrl).toBeUndefined();
    expect(config.certificate).toContain('SPCERT');
    expect(config.authnRequestSignaturePolicy).toBe('required');
    expect(config.signAssertions).toBe(true);
    expect(config.signResponses).toBe(true);
    expect(config.allowedBindings).toEqual(['post']);
  });

  it('exports and imports SP encryption certificates separately from signing certificates', () => {
    const xml = buildSPMetadata({
      entityId: 'https://tenant.example.com/saml/sp',
      issuerUrl: 'https://tenant.example.com',
      signingCertificates: [
        {
          slot: 'active',
          certificate: '-----BEGIN CERTIFICATE-----\nSIGNCERT\n-----END CERTIFICATE-----',
        },
      ],
      encryptionCertificates: ['-----BEGIN CERTIFICATE-----\nENCCERT\n-----END CERTIFICATE-----'],
    });

    const doc = parseXml(xml);
    const descriptor = findElement(doc, SAML_NAMESPACES.MD, 'SPSSODescriptor');
    const keyDescriptors = Array.from(
      descriptor!.getElementsByTagNameNS(SAML_NAMESPACES.MD, 'KeyDescriptor')
    );
    const config = parseSPMetadata(xml);

    expect(keyDescriptors.map((keyDescriptor) => getAttribute(keyDescriptor, 'use'))).toEqual([
      'signing',
      'encryption',
    ]);
    expect(config.certificate).toContain('SIGNCERT');
    expect(config.encryptionCertificate).toContain('ENCCERT');
    expect(config.encryptionCertificates).toEqual([
      '-----BEGIN CERTIFICATE-----\nENCCERT\n-----END CERTIFICATE-----',
    ]);
    expect(config.encryptAssertions).toBeUndefined();
  });

  it('imports AttributeConsumingService RequestedAttribute as release policy suggestions', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="https://publisher.example.test/saml/sp">
  <md:SPSSODescriptor
    AuthnRequestsSigned="true"
    WantAssertionsSigned="true"
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="https://publisher.example.test/saml/acs"
      index="0"
      isDefault="true" />
    <md:AttributeConsumingService index="7" isDefault="true">
      <md:ServiceName xml:lang="en">Publisher access</md:ServiceName>
      <md:RequestedAttribute
        Name="urn:oid:0.9.2342.19200300.100.1.3"
        NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:uri"
        FriendlyName="mail"
        isRequired="true" />
      <md:RequestedAttribute
        Name="urn:oid:1.3.6.1.4.1.5923.1.1.1.9"
        NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:uri"
        FriendlyName="eduPersonScopedAffiliation" />
      <md:RequestedAttribute
        Name="urn:example:library-card"
        FriendlyName="libraryCard"
        isRequired="true" />
    </md:AttributeConsumingService>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;

    const config = parseSPMetadata(xml, 'academic_publisher');

    expect(config.metadataRequestedAttributes).toEqual([
      {
        name: 'urn:oid:0.9.2342.19200300.100.1.3',
        nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
        friendlyName: 'mail',
        isRequired: true,
        attributeConsumingServiceIndex: 7,
        attributeConsumingServiceName: 'Publisher access',
      },
      {
        name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.9',
        nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
        friendlyName: 'eduPersonScopedAffiliation',
        isRequired: false,
        attributeConsumingServiceIndex: 7,
        attributeConsumingServiceName: 'Publisher access',
      },
      {
        name: 'urn:example:library-card',
        friendlyName: 'libraryCard',
        isRequired: true,
        attributeConsumingServiceIndex: 7,
        attributeConsumingServiceName: 'Publisher access',
      },
    ]);
    expect(config.metadataAttributeReleasePolicySuggestion).toEqual({
      attributes: [
        {
          name: 'urn:oid:0.9.2342.19200300.100.1.3',
          friendlyName: 'mail',
          nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
          source: 'claim',
          claim: 'email',
          required: true,
        },
        {
          name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.9',
          friendlyName: 'eduPersonScopedAffiliation',
          nameFormat: 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri',
          source: 'computed',
          computed: 'eduPersonScopedAffiliation',
          claim: 'eduPersonScopedAffiliation',
          required: false,
        },
        {
          name: 'urn:example:library-card',
          friendlyName: 'libraryCard',
          source: 'custom_claim',
          claim: 'libraryCard',
          required: true,
        },
      ],
    });
    expect(config.attributeReleasePolicy).toBeUndefined();
  });

  it('generates stable Authrim SP metadata XML for the same metadata inputs', () => {
    const options = {
      entityId: 'https://tenant.example.com/saml/sp',
      issuerUrl: 'https://tenant.example.com',
      signingCertificates: [
        {
          slot: 'active' as const,
          certificate: '-----BEGIN CERTIFICATE-----\nSPCERT\n-----END CERTIFICATE-----',
        },
      ],
    };

    const firstXml = buildSPMetadata(options);
    const secondXml = buildSPMetadata(options);
    const doc = parseXml(firstXml);
    const entityDescriptor = findElement(doc, SAML_NAMESPACES.MD, 'EntityDescriptor');

    expect(firstXml).toBe(secondXml);
    expect(getAttribute(entityDescriptor!, 'ID')).toMatch(/^_authrim_saml_sp_[a-z0-9]+$/);
    expect(getAttribute(entityDescriptor!, 'cacheDuration')).toBe('PT24H');
    expect(getAttribute(entityDescriptor!, 'validUntil')).toBe('');
  });

  it('prefers Redirect SLO for non-legacy SP metadata imports and POST for legacy imports', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="https://dual-slo.example.test/saml/sp">
  <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="https://dual-slo.example.test/saml/acs"
      index="0"
      isDefault="true" />
    <md:SingleLogoutService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="https://dual-slo.example.test/saml/slo/post"
      ResponseLocation="https://dual-slo.example.test/saml/slo/post/response" />
    <md:SingleLogoutService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
      Location="https://dual-slo.example.test/saml/slo/redirect"
      ResponseLocation="https://dual-slo.example.test/saml/slo/redirect/response" />
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;

    expect(parseSPMetadata(xml, 'strict')).toMatchObject({
      sloUrl: 'https://dual-slo.example.test/saml/slo/redirect',
      sloResponseUrl: 'https://dual-slo.example.test/saml/slo/redirect/response',
      sloBinding: 'redirect',
    });
    expect(parseSPMetadata(xml, 'academic_publisher')).toMatchObject({
      sloUrl: 'https://dual-slo.example.test/saml/slo/redirect',
      sloResponseUrl: 'https://dual-slo.example.test/saml/slo/redirect/response',
      sloBinding: 'redirect',
    });
    expect(parseSPMetadata(xml, 'legacy')).toMatchObject({
      sloUrl: 'https://dual-slo.example.test/saml/slo/post',
      sloResponseUrl: 'https://dual-slo.example.test/saml/slo/post/response',
      sloBinding: 'post',
    });
  });

  it('rejects expired metadata validUntil values', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="https://expired.example.test/saml/sp"
  validUntil="2020-01-01T00:00:00Z">
  <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="https://expired.example.test/saml/acs"
      index="0"
      isDefault="true" />
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;

    expect(() => parseSPMetadata(xml)).toThrow('expired validUntil');
  });

  it('roundtrips Authrim IdP metadata export through metadata import parser', () => {
    const xml = buildIdPMetadata({
      entityId: 'https://tenant.example.com/saml/idp',
      issuerUrl: 'https://tenant.example.com',
      signingCertificates: [
        {
          slot: 'active',
          certificate: '-----BEGIN CERTIFICATE-----\nIDPCERT\n-----END CERTIFICATE-----',
        },
      ],
    });

    const config = parseIdPMetadata(xml);

    expect(config.entityId).toBe('https://tenant.example.com/saml/idp');
    expect(config.ssoUrl).toBe('https://tenant.example.com/saml/idp/sso');
    expect(config.sloUrl).toBe('https://tenant.example.com/saml/idp/slo');
    expect(config.certificate).toContain('IDPCERT');
    expect(config.allowedBindings).toEqual(['post', 'redirect']);
  });

  it('prefers Redirect SSO and SLO endpoints when IdP metadata publishes both POST and Redirect', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  xmlns:mdui="urn:oasis:names:tc:SAML:metadata:ui"
  entityID="https://test-idp1.gakunin.nii.ac.jp/idp/shibboleth">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:Extensions>
      <mdui:UIInfo>
        <mdui:Logo xml:lang="en" width="64" height="64">https://test-idp1.gakunin.nii.ac.jp/logo.png</mdui:Logo>
      </mdui:UIInfo>
    </md:Extensions>
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo>
        <ds:X509Data>
          <ds:X509Certificate>IDPCERT</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:NameIDFormat>urn:mace:shibboleth:1.0:nameIdentifier</md:NameIDFormat>
    <md:SingleSignOnService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="https://test-idp1.gakunin.nii.ac.jp/idp/profile/SAML2/POST/SSO" />
    <md:SingleSignOnService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
      Location="https://test-idp1.gakunin.nii.ac.jp/idp/profile/SAML2/Redirect/SSO" />
    <md:SingleLogoutService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="https://test-idp1.gakunin.nii.ac.jp/idp/profile/SAML2/POST/SLO" />
    <md:SingleLogoutService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"
      Location="https://test-idp1.gakunin.nii.ac.jp/idp/profile/SAML2/Redirect/SLO" />
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

    const config = parseIdPMetadata(xml);

    expect(config.ssoUrl).toBe(
      'https://test-idp1.gakunin.nii.ac.jp/idp/profile/SAML2/Redirect/SSO'
    );
    expect(config.sloUrl).toBe(
      'https://test-idp1.gakunin.nii.ac.jp/idp/profile/SAML2/Redirect/SLO'
    );
    expect(config.nameIdFormat).toBe('urn:mace:shibboleth:1.0:nameIdentifier');
    expect(config.allowedBindings).toEqual(['post', 'redirect']);
    expect(config.logoUrl).toBe('https://test-idp1.gakunin.nii.ac.jp/logo.png');
  });

  it('explains when SP metadata is imported as IdP metadata', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="https://sp.example.test/saml/sp">
  <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="https://sp.example.test/saml/acs"
      index="0"
      isDefault="true" />
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;

    expect(() => parseIdPMetadata(xml)).toThrow(
      'Metadata is for a SAML Service Provider, not an Identity Provider'
    );
  });

  it('explains when IdP metadata is imported as SP metadata', () => {
    const xml = buildIdPMetadata({
      entityId: 'https://tenant.example.com/saml/idp',
      issuerUrl: 'https://tenant.example.com',
      signingCertificates: [
        {
          slot: 'active',
          certificate: '-----BEGIN CERTIFICATE-----\nIDPCERT\n-----END CERTIFICATE-----',
        },
      ],
    });

    expect(() => parseSPMetadata(xml)).toThrow(
      'Metadata is for a SAML Identity Provider, not a Service Provider'
    );
  });

  it('previews metadata and detects the provider role before registration', async () => {
    const response = await handlePreviewMetadata(
      createPreviewContext({
        metadataXml: buildIdPMetadata({
          entityId: 'https://tenant.example.com/saml/idp',
          issuerUrl: 'https://tenant.example.com',
          signingCertificates: [
            {
              slot: 'active',
              certificate: '-----BEGIN CERTIFICATE-----\nIDPCERT\n-----END CERTIFICATE-----',
            },
          ],
        }),
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      providerType: string;
      config: { entityId: string; ssoUrl?: string };
    };
    expect(body.providerType).toBe('saml_idp');
    expect(body.config.entityId).toBe('https://tenant.example.com/saml/idp');
    expect(body.config.ssoUrl).toBe('https://tenant.example.com/saml/idp/sso');
  });

  it('previews SP metadata as a service provider registration', async () => {
    const response = await handlePreviewMetadata(
      createPreviewContext({
        metadataXml: `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="IAMShowcase">
  <md:SPSSODescriptor
    AuthnRequestsSigned="false"
    WantAssertionsSigned="false"
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="https://sptest.iamshowcase.com/acs"
      index="0"
      isDefault="true" />
  </md:SPSSODescriptor>
</md:EntityDescriptor>`,
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      providerType: string;
      config: { entityId: string; acsUrl?: string; authnRequestSignaturePolicy?: string };
    };
    expect(body.providerType).toBe('saml_sp');
    expect(body.config.entityId).toBe('IAMShowcase');
    expect(body.config.acsUrl).toBe('https://sptest.iamshowcase.com/acs');
    expect(body.config.authnRequestSignaturePolicy).toBe('optional');
  });
});

function createPreviewContext(body: unknown) {
  return {
    req: {
      json: async () => body,
      header: () => undefined,
    },
    get: (key: string) =>
      key === 'adminAuth' ? { permissions: ['admin:saml_providers:create'] } : undefined,
    json: (value: unknown, status?: number) =>
      new Response(JSON.stringify(value), {
        status: status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    env: {},
  } as never;
}
