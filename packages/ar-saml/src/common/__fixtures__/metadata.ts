import { BINDING_URIS, NAMEID_FORMATS, SAML_NAMESPACES } from '../constants';

const CERT_A =
  'MIICozCCAYsCBgGXsyntheticAANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAlTeW50aGV0aWMwHhcNMjYwMTAxMDAwMDAwWhcNMzYwMTAxMDAwMDAwWjAUMRIwEAYDVQQDDAlTeW50aGV0aWMwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCsyntheticA';
const CERT_B =
  'MIICozCCAYsCBgGXsyntheticBBNBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAlTeW50aGV0aWMwHhcNMjYwMTAxMDAwMDAwWhcNMzYwMTAxMDAwMDAwWjAUMRIwEAYDVQQDDAlTeW50aGV0aWMwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCsyntheticB';

export const syntheticAcademicPublisherSPMetadata = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="${SAML_NAMESPACES.MD}"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  entityID="https://publisher.example.test/saml/sp">
  <md:SPSSODescriptor
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"
    AuthnRequestsSigned="true"
    WantAssertionsSigned="true">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo>
        <ds:X509Data>
          <ds:X509Certificate>${CERT_A}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:NameIDFormat>${NAMEID_FORMATS.PERSISTENT}</md:NameIDFormat>
    <md:AssertionConsumerService
      Binding="${BINDING_URIS.HTTP_POST}"
      Location="https://publisher.example.test/saml/acs"
      index="0"
      isDefault="true" />
    <md:SingleLogoutService
      Binding="${BINDING_URIS.HTTP_REDIRECT}"
      Location="https://publisher.example.test/saml/slo"
      ResponseLocation="https://publisher.example.test/saml/slo/response" />
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;

export const syntheticLegacyPublisherSPMetadata = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  entityID="https://legacy-publisher.example.test/saml/sp">
  <md:SPSSODescriptor
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"
    WantAssertionsSigned="false">
    <md:NameIDFormat>${NAMEID_FORMATS.EMAIL}</md:NameIDFormat>
    <md:AssertionConsumerService
      Binding="${BINDING_URIS.HTTP_POST}"
      Location="https://legacy-publisher.example.test/saml/acs"
      index="0"
      isDefault="true" />
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;

export const syntheticPublisherRequestedAttributesSPMetadata = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  entityID="https://requested-attrs-publisher.example.test/saml/sp">
  <md:SPSSODescriptor
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"
    AuthnRequestsSigned="true"
    WantAssertionsSigned="true">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo>
        <ds:X509Data>
          <ds:X509Certificate>${CERT_A}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:NameIDFormat>${NAMEID_FORMATS.PERSISTENT}</md:NameIDFormat>
    <md:AssertionConsumerService
      Binding="${BINDING_URIS.HTTP_POST}"
      Location="https://requested-attrs-publisher.example.test/saml/acs"
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

export const syntheticResearchPlatformSPMetadata = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  entityID="https://research-platform.example.test/saml/sp">
  <md:SPSSODescriptor
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"
    AuthnRequestsSigned="true"
    WantAssertionsSigned="true">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo>
        <ds:X509Data>
          <ds:X509Certificate>${CERT_B}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:NameIDFormat>${NAMEID_FORMATS.TRANSIENT}</md:NameIDFormat>
    <md:AssertionConsumerService
      Binding="${BINDING_URIS.HTTP_REDIRECT}"
      Location="https://research-platform.example.test/saml/acs/redirect"
      index="0" />
    <md:AssertionConsumerService
      Binding="${BINDING_URIS.HTTP_POST}"
      Location="https://research-platform.example.test/saml/acs/post"
      index="1"
      isDefault="true" />
    <md:SingleLogoutService
      Binding="${BINDING_URIS.HTTP_POST}"
      Location="https://research-platform.example.test/saml/slo/post" />
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;

export const syntheticSPMetadataFixtures = [
  {
    id: 'academic-publisher-strict',
    profile: 'academic_publisher',
    metadataXml: syntheticAcademicPublisherSPMetadata,
    expected: {
      entityId: 'https://publisher.example.test/saml/sp',
      acsUrl: 'https://publisher.example.test/saml/acs',
      acsUrls: ['https://publisher.example.test/saml/acs'] as const,
      acsServices: [
        {
          index: 0,
          binding: 'post',
          location: 'https://publisher.example.test/saml/acs',
          isDefault: true,
        },
      ] as const,
      sloUrl: 'https://publisher.example.test/saml/slo',
      sloResponseUrl: 'https://publisher.example.test/saml/slo/response',
      sloBinding: 'redirect',
      authnRequestSignaturePolicy: 'required',
      signAssertions: true,
      signResponses: true,
      nameIdFormat: NAMEID_FORMATS.PERSISTENT,
      allowedBindings: ['post'] as const,
      hasCertificate: true,
    },
  },
  {
    id: 'academic-publisher-legacy',
    profile: 'academic_publisher',
    metadataXml: syntheticLegacyPublisherSPMetadata,
    expected: {
      entityId: 'https://legacy-publisher.example.test/saml/sp',
      acsUrl: 'https://legacy-publisher.example.test/saml/acs',
      acsUrls: ['https://legacy-publisher.example.test/saml/acs'] as const,
      acsServices: [
        {
          index: 0,
          binding: 'post',
          location: 'https://legacy-publisher.example.test/saml/acs',
          isDefault: true,
        },
      ] as const,
      sloUrl: undefined,
      sloResponseUrl: undefined,
      sloBinding: undefined,
      authnRequestSignaturePolicy: 'optional',
      signAssertions: false,
      signResponses: true,
      nameIdFormat: NAMEID_FORMATS.EMAIL,
      allowedBindings: ['post'] as const,
      hasCertificate: false,
    },
  },
  {
    id: 'academic-publisher-requested-attributes',
    profile: 'academic_publisher',
    metadataXml: syntheticPublisherRequestedAttributesSPMetadata,
    expected: {
      entityId: 'https://requested-attrs-publisher.example.test/saml/sp',
      acsUrl: 'https://requested-attrs-publisher.example.test/saml/acs',
      acsUrls: ['https://requested-attrs-publisher.example.test/saml/acs'] as const,
      acsServices: [
        {
          index: 0,
          binding: 'post',
          location: 'https://requested-attrs-publisher.example.test/saml/acs',
          isDefault: true,
        },
      ] as const,
      sloUrl: undefined,
      sloResponseUrl: undefined,
      sloBinding: undefined,
      authnRequestSignaturePolicy: 'required',
      signAssertions: true,
      signResponses: true,
      nameIdFormat: NAMEID_FORMATS.PERSISTENT,
      allowedBindings: ['post'] as const,
      hasCertificate: true,
      metadataRequestedAttributeCount: 3,
      metadataSuggestedAttributeCount: 3,
    },
  },
  {
    id: 'research-platform-strict',
    profile: 'research_federation',
    metadataXml: syntheticResearchPlatformSPMetadata,
    expected: {
      entityId: 'https://research-platform.example.test/saml/sp',
      acsUrl: 'https://research-platform.example.test/saml/acs/post',
      acsUrls: [
        'https://research-platform.example.test/saml/acs/redirect',
        'https://research-platform.example.test/saml/acs/post',
      ] as const,
      acsServices: [
        {
          index: 0,
          binding: 'redirect',
          location: 'https://research-platform.example.test/saml/acs/redirect',
          isDefault: false,
        },
        {
          index: 1,
          binding: 'post',
          location: 'https://research-platform.example.test/saml/acs/post',
          isDefault: true,
        },
      ] as const,
      sloUrl: 'https://research-platform.example.test/saml/slo/post',
      sloResponseUrl: undefined,
      sloBinding: 'post',
      authnRequestSignaturePolicy: 'required',
      signAssertions: true,
      signResponses: true,
      nameIdFormat: NAMEID_FORMATS.TRANSIENT,
      allowedBindings: ['redirect', 'post'] as const,
      hasCertificate: true,
    },
  },
] as const;
