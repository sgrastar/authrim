import { describe, expect, it } from 'vitest';
import {
  extractEntityDescriptorXml,
  parseAggregateMetadata,
  verifyAggregateMetadataSignature,
} from '../../packages/ar-saml/src/admin/aggregate-metadata';
import { SAMLMetadataValidationError } from '../../packages/ar-saml/src/admin/errors';
import {
  applySAMLSPProfileDefaults,
  selectSAMLSPNameIDFormat,
} from '../../packages/ar-saml/src/admin/profile-defaults';
import { parseIdPMetadata, parseSPMetadata } from '../../packages/ar-saml/src/admin/providers';
import { BINDING_URIS, NAMEID_FORMATS } from '../../packages/ar-saml/src/common/constants';
import {
  ACADEMIC_PUBLISHER_ATTRIBUTES,
  ENTERPRISE_SAAS_ATTRIBUTES,
  RESEARCH_FEDERATION_ATTRIBUTES,
  SAML_ATTRIBUTE_NAME_FORMAT_URI,
  buildAcademicPublisherAttributeReleaseRules,
  buildEnterpriseSaaSAttributeReleaseRules,
  buildResearchFederationAttributeReleaseRules,
} from '../../packages/ar-saml/src/idp/attribute-presets';

const ACTIVE_CERTIFICATE_BODY = 'QXV0aHJpbS1mZWRlcmF0aW9uLWFjdGl2ZS1jZXJ0aWZpY2F0ZQ==';
const NEXT_CERTIFICATE_BODY = 'QXV0aHJpbS1mZWRlcmF0aW9uLW5leHQtY2VydGlmaWNhdGU=';
const FUTURE_VALID_UNTIL = '2099-12-31T23:59:59Z';

interface EnterpriseIdPProfile {
  id: string;
  entityId: string;
  ssoUrl: string;
  sloUrl?: string;
  nameIdFormat: string;
  bindings: Array<'post' | 'redirect'>;
}

const ENTERPRISE_IDP_PROFILES: EnterpriseIdPProfile[] = [
  {
    id: 'Microsoft Entra ID',
    entityId: 'https://sts.windows.net/11111111-2222-3333-4444-555555555555/',
    ssoUrl: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/saml2',
    sloUrl: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/saml2',
    nameIdFormat: NAMEID_FORMATS.PERSISTENT,
    bindings: ['post', 'redirect'],
  },
  {
    id: 'Okta Workforce Identity',
    entityId: 'http://www.okta.com/exk1234567890',
    ssoUrl: 'https://workforce.example.okta.com/app/authrim/exk1234567890/sso/saml',
    nameIdFormat: NAMEID_FORMATS.EMAIL,
    bindings: ['redirect'],
  },
  {
    id: 'Google Workspace',
    entityId: 'https://accounts.google.com/o/saml2?idpid=C01234567',
    ssoUrl: 'https://accounts.google.com/o/saml2/idp?idpid=C01234567',
    nameIdFormat: NAMEID_FORMATS.EMAIL,
    bindings: ['redirect'],
  },
];

function buildEnterpriseIdPMetadata(profile: EnterpriseIdPProfile): string {
  const ssoServices = profile.bindings
    .map(
      (binding) =>
        `<md:SingleSignOnService Binding=\"${
          binding === 'post' ? BINDING_URIS.HTTP_POST : BINDING_URIS.HTTP_REDIRECT
        }\" Location=\"${escapeXml(profile.ssoUrl)}\"/>`
    )
    .join('');
  const sloService = profile.sloUrl
    ? `<md:SingleLogoutService Binding=\"${BINDING_URIS.HTTP_REDIRECT}\" Location=\"${escapeXml(
        profile.sloUrl
      )}\"/>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  entityID="${escapeXml(profile.entityId)}" validUntil="${FUTURE_VALID_UNTIL}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data>
      <ds:X509Certificate>${ACTIVE_CERTIFICATE_BODY}</ds:X509Certificate>
    </ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data>
      <ds:X509Certificate>${NEXT_CERTIFICATE_BODY}</ds:X509Certificate>
    </ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data>
      <ds:X509Certificate>${ACTIVE_CERTIFICATE_BODY}</ds:X509Certificate>
    </ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    ${sloService}
    <md:NameIDFormat>${profile.nameIdFormat}</md:NameIDFormat>
    ${ssoServices}
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}

const GAKUNIN_IDP_ENTITY_ID = 'https://idp.example.ac.jp/idp/shibboleth';
const RESEARCH_SP_ENTITY_ID = 'https://research.example.edu/shibboleth';

const ACADEMIC_AGGREGATE_METADATA = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntitiesDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  xmlns:mdui="urn:oasis:names:tc:SAML:metadata:ui"
  ID="_edugain_style_aggregate" validUntil="${FUTURE_VALID_UNTIL}">
  <md:EntityDescriptor entityID="${GAKUNIN_IDP_ENTITY_ID}" validUntil="${FUTURE_VALID_UNTIL}">
    <md:Extensions><mdui:UIInfo>
      <mdui:DisplayName xml:lang="ja">学術認証IdP</mdui:DisplayName>
      <mdui:DisplayName xml:lang="en">Academic Identity Provider</mdui:DisplayName>
      <mdui:Logo xml:lang="ja" width="64" height="64">https://idp.example.ac.jp/logo.png</mdui:Logo>
    </mdui:UIInfo></md:Extensions>
    <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
      <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data>
        <ds:X509Certificate>${ACTIVE_CERTIFICATE_BODY}</ds:X509Certificate>
      </ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
      <md:SingleLogoutService Binding="${BINDING_URIS.HTTP_POST}"
        Location="https://idp.example.ac.jp/idp/profile/SAML2/POST/SLO"/>
      <md:SingleLogoutService Binding="${BINDING_URIS.HTTP_REDIRECT}"
        Location="https://idp.example.ac.jp/idp/profile/SAML2/Redirect/SLO"/>
      <md:NameIDFormat>${NAMEID_FORMATS.SHIBBOLETH}</md:NameIDFormat>
      <md:NameIDFormat>${NAMEID_FORMATS.PERSISTENT}</md:NameIDFormat>
      <md:SingleSignOnService Binding="${BINDING_URIS.HTTP_POST}"
        Location="https://idp.example.ac.jp/idp/profile/SAML2/POST/SSO"/>
      <md:SingleSignOnService Binding="${BINDING_URIS.HTTP_REDIRECT}"
        Location="https://idp.example.ac.jp/idp/profile/SAML2/Redirect/SSO"/>
    </md:IDPSSODescriptor>
  </md:EntityDescriptor>
  <md:EntityDescriptor entityID="${RESEARCH_SP_ENTITY_ID}" validUntil="${FUTURE_VALID_UNTIL}">
    <md:Extensions><mdui:UIInfo>
      <mdui:DisplayName xml:lang="en">Research Collaboration Service</mdui:DisplayName>
    </mdui:UIInfo></md:Extensions>
    <md:SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"
      AuthnRequestsSigned="true" WantAssertionsSigned="true">
      <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data>
        <ds:X509Certificate>${NEXT_CERTIFICATE_BODY}</ds:X509Certificate>
      </ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
      <md:SingleLogoutService Binding="${BINDING_URIS.HTTP_POST}"
        Location="https://research.example.edu/SAML2/POST/SLO"
        ResponseLocation="https://research.example.edu/SAML2/POST/SLO/Response"/>
      <md:SingleLogoutService Binding="${BINDING_URIS.HTTP_REDIRECT}"
        Location="https://research.example.edu/SAML2/Redirect/SLO"/>
      <md:NameIDFormat>${NAMEID_FORMATS.TRANSIENT}</md:NameIDFormat>
      <md:NameIDFormat>${NAMEID_FORMATS.PERSISTENT}</md:NameIDFormat>
      <md:AssertionConsumerService Binding="${BINDING_URIS.HTTP_REDIRECT}"
        Location="https://research.example.edu/SAML2/Redirect/ACS" index="0"/>
      <md:AssertionConsumerService Binding="${BINDING_URIS.HTTP_POST}"
        Location="https://research.example.edu/SAML2/POST/ACS" index="1" isDefault="true"/>
      <md:AttributeConsumingService index="3">
        <md:ServiceName xml:lang="en">Research access</md:ServiceName>
        <md:RequestedAttribute Name="${RESEARCH_FEDERATION_ATTRIBUTES.mail.name}"
          FriendlyName="mail" NameFormat="${SAML_ATTRIBUTE_NAME_FORMAT_URI}" isRequired="true"/>
        <md:RequestedAttribute Name="${RESEARCH_FEDERATION_ATTRIBUTES.eduPersonPrincipalName.name}"
          FriendlyName="eduPersonPrincipalName" NameFormat="${SAML_ATTRIBUTE_NAME_FORMAT_URI}"
          isRequired="true"/>
        <md:RequestedAttribute Name="${RESEARCH_FEDERATION_ATTRIBUTES.eduPersonScopedAffiliation.name}"
          FriendlyName="eduPersonScopedAffiliation" NameFormat="${SAML_ATTRIBUTE_NAME_FORMAT_URI}"
          isRequired="true"/>
        <md:RequestedAttribute Name="${RESEARCH_FEDERATION_ATTRIBUTES.eduPersonEntitlement.name}"
          FriendlyName="eduPersonEntitlement" NameFormat="${SAML_ATTRIBUTE_NAME_FORMAT_URI}"/>
      </md:AttributeConsumingService>
    </md:SPSSODescriptor>
  </md:EntityDescriptor>
</md:EntitiesDescriptor>`;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

describe('enterprise SAML identity-provider profiles', () => {
  it.each(ENTERPRISE_IDP_PROFILES)(
    'imports the $id metadata shape with exact issuer and endpoint binding',
    (profile) => {
      expect.hasAssertions();
      const config = parseIdPMetadata(buildEnterpriseIdPMetadata(profile));

      expect(config.entityId).toBe(profile.entityId);
      expect(config.ssoUrl).toBe(profile.ssoUrl);
      expect(config.sloUrl).toBe(profile.sloUrl);
      expect(config.nameIdFormat).toBe(profile.nameIdFormat);
      expect(new Set(config.allowedBindings)).toEqual(new Set(profile.bindings));
    }
  );

  it.each(ENTERPRISE_IDP_PROFILES)(
    'keeps active and next signing certificates for $id rollover without duplicates',
    (profile) => {
      expect.hasAssertions();
      const config = parseIdPMetadata(buildEnterpriseIdPMetadata(profile));

      expect(config.certificates).toHaveLength(2);
      expect(config.certificate).toContain(ACTIVE_CERTIFICATE_BODY);
      expect(config.certificates?.[1]).toContain(NEXT_CERTIFICATE_BODY);
      expect(config.certificates?.every((certificate) => !certificate.includes('PRIVATE'))).toBe(
        true
      );
    }
  );

  it('prefers HTTP-Redirect for outbound AuthnRequest when enterprise metadata publishes both', () => {
    expect.hasAssertions();
    const entra = parseIdPMetadata(buildEnterpriseIdPMetadata(ENTERPRISE_IDP_PROFILES[0]));

    expect(entra.allowedBindings).toContain('post');
    expect(entra.allowedBindings).toContain('redirect');
    expect(entra.ssoUrl).toContain('login.microsoftonline.com');
  });

  it('rejects expired enterprise metadata before accepting its endpoints or certificates', () => {
    expect.hasAssertions();
    const expired = buildEnterpriseIdPMetadata(ENTERPRISE_IDP_PROFILES[1]).replace(
      FUTURE_VALID_UNTIL,
      '2020-01-01T00:00:00Z'
    );

    expect(() => parseIdPMetadata(expired)).toThrow('Invalid metadata: expired validUntil');
  });

  it('rejects enterprise IdP metadata without a signing certificate', () => {
    expect.hasAssertions();
    const withoutCertificates = buildEnterpriseIdPMetadata(ENTERPRISE_IDP_PROFILES[2]).replace(
      /<md:KeyDescriptor[\s\S]*?<\/md:KeyDescriptor>/g,
      ''
    );

    expect(() => parseIdPMetadata(withoutCertificates)).toThrow(
      'Invalid metadata: no signing certificate found'
    );
  });

  it('rejects an SP descriptor presented through the enterprise IdP import path', () => {
    expect.hasAssertions();
    const spOnly = extractEntityDescriptorXml(ACADEMIC_AGGREGATE_METADATA, RESEARCH_SP_ENTITY_ID);

    expect(() => parseIdPMetadata(spOnly)).toThrow(
      'Metadata is for a SAML Service Provider, not an Identity Provider'
    );
  });

  it('defines the common workforce email, name, given-name, surname, and group release contract', () => {
    expect.hasAssertions();
    const rules = buildEnterpriseSaaSAttributeReleaseRules();

    expect(rules.map((rule) => rule.name)).toEqual([
      ENTERPRISE_SAAS_ATTRIBUTES.mail.name,
      ENTERPRISE_SAAS_ATTRIBUTES.displayName.name,
      ENTERPRISE_SAAS_ATTRIBUTES.givenName.name,
      ENTERPRISE_SAAS_ATTRIBUTES.surname.name,
      ENTERPRISE_SAAS_ATTRIBUTES.memberOf.name,
    ]);
    expect(rules.every((rule) => rule.nameFormat === SAML_ATTRIBUTE_NAME_FORMAT_URI)).toBe(true);
    expect(rules.find((rule) => rule.friendlyName === 'mail')?.required).toBe(true);
    expect(rules.find((rule) => rule.friendlyName === 'memberOf')?.required).toBe(false);
  });

  it.each([
    [
      'Microsoft Entra ID claim URI',
      'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
      'groups',
    ],
    ['Okta application group statement', 'Groups', 'Groups'],
    ['Google Workspace custom group attribute', 'groups', 'groups'],
  ])('supports a per-application group alias for %s', (_label, name, friendlyName) => {
    expect.hasAssertions();
    const rules = buildEnterpriseSaaSAttributeReleaseRules({
      groupsAttributeName: name,
      groupsFriendlyName: friendlyName,
      groupsClaim: 'groups',
    });

    expect(rules.at(-1)).toMatchObject({
      name,
      friendlyName,
      claim: 'groups',
      source: 'custom_claim',
      required: false,
    });
  });
});

describe('academic and research federation profiles', () => {
  it('enumerates GakuNin/Shibboleth IdP and research SP entities from an aggregate', () => {
    expect.hasAssertions();
    const aggregate = parseAggregateMetadata(ACADEMIC_AGGREGATE_METADATA);

    expect(aggregate.rootId).toBe('_edugain_style_aggregate');
    expect(aggregate.validUntil).toBe(FUTURE_VALID_UNTIL);
    expect(aggregate.entities).toHaveLength(2);
    expect(aggregate.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: GAKUNIN_IDP_ENTITY_ID,
          role: 'saml_idp',
          displayName: 'Academic Identity Provider',
          certificateCount: 1,
        }),
        expect.objectContaining({
          entityId: RESEARCH_SP_ENTITY_ID,
          role: 'saml_sp',
          displayName: 'Research Collaboration Service',
          certificateCount: 1,
        }),
      ])
    );
  });

  it('imports GakuNin/Shibboleth aliases and presentation data from the selected IdP entity', () => {
    expect.hasAssertions();
    const xml = extractEntityDescriptorXml(ACADEMIC_AGGREGATE_METADATA, GAKUNIN_IDP_ENTITY_ID);
    const config = parseIdPMetadata(xml);

    expect(config.entityId).toBe(GAKUNIN_IDP_ENTITY_ID);
    expect(config.ssoUrl).toBe('https://idp.example.ac.jp/idp/profile/SAML2/Redirect/SSO');
    expect(config.sloUrl).toBe('https://idp.example.ac.jp/idp/profile/SAML2/Redirect/SLO');
    expect(config.nameIdFormat).toBe(NAMEID_FORMATS.SHIBBOLETH);
    expect(config.allowedBindings).toEqual(['post', 'redirect']);
    expect(config.logoUrl).toBe('https://idp.example.ac.jp/logo.png');
  });

  it('imports a multi-ACS research SP and applies the strict academic publisher profile', () => {
    expect.hasAssertions();
    const xml = extractEntityDescriptorXml(ACADEMIC_AGGREGATE_METADATA, RESEARCH_SP_ENTITY_ID);
    const config = applySAMLSPProfileDefaults(
      parseSPMetadata(xml, 'academic_publisher'),
      'academic_publisher'
    );

    expect(config).toMatchObject({
      entityId: RESEARCH_SP_ENTITY_ID,
      acsUrl: 'https://research.example.edu/SAML2/POST/ACS',
      acsUrls: [
        'https://research.example.edu/SAML2/Redirect/ACS',
        'https://research.example.edu/SAML2/POST/ACS',
      ],
      samlProfile: 'academic_publisher',
      authnRequestSignaturePolicy: 'required',
      signAssertions: true,
      signResponses: true,
      nameIdFormat: NAMEID_FORMATS.PERSISTENT,
      sloBinding: 'redirect',
      sloUrl: 'https://research.example.edu/SAML2/Redirect/SLO',
    });
    expect(config.acsServices).toEqual([
      {
        index: 0,
        binding: 'redirect',
        location: 'https://research.example.edu/SAML2/Redirect/ACS',
        isDefault: false,
      },
      {
        index: 1,
        binding: 'post',
        location: 'https://research.example.edu/SAML2/POST/ACS',
        isDefault: true,
      },
    ]);
  });

  it('converts RequestedAttribute OIDs into a reviewable release-policy suggestion', () => {
    expect.hasAssertions();
    const xml = extractEntityDescriptorXml(ACADEMIC_AGGREGATE_METADATA, RESEARCH_SP_ENTITY_ID);
    const config = parseSPMetadata(xml, 'academic_publisher');

    expect(config.metadataRequestedAttributes).toHaveLength(4);
    expect(config.metadataAttributeReleasePolicySuggestion?.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: RESEARCH_FEDERATION_ATTRIBUTES.mail.name,
          friendlyName: 'mail',
          claim: 'email',
          required: true,
        }),
        expect.objectContaining({
          name: RESEARCH_FEDERATION_ATTRIBUTES.eduPersonPrincipalName.name,
          friendlyName: 'eduPersonPrincipalName',
          claim: 'eduPersonPrincipalName',
          required: true,
        }),
        expect.objectContaining({
          name: RESEARCH_FEDERATION_ATTRIBUTES.eduPersonScopedAffiliation.name,
          friendlyName: 'eduPersonScopedAffiliation',
          computed: 'eduPersonScopedAffiliation',
          required: true,
        }),
        expect.objectContaining({
          name: RESEARCH_FEDERATION_ATTRIBUTES.eduPersonEntitlement.name,
          friendlyName: 'eduPersonEntitlement',
          claim: 'eduPersonEntitlement',
          required: false,
        }),
      ])
    );
  });

  it('keeps an advertised email NameID when a publisher does not support persistent identifiers', () => {
    expect.hasAssertions();
    const config = applySAMLSPProfileDefaults(
      {
        entityId: 'https://legacy-publisher.example/saml/sp',
        acsUrl: 'https://legacy-publisher.example/saml/acs',
        nameIdFormat: NAMEID_FORMATS.EMAIL,
        metadataNameIdFormats: [NAMEID_FORMATS.EMAIL],
        attributeMapping: {},
        signAssertions: false,
        signResponses: true,
        allowedBindings: ['post'],
      },
      'academic_publisher'
    );

    expect(config.nameIdFormat).toBe(NAMEID_FORMATS.EMAIL);
    expect(config.signAssertions).toBe(true);
    expect(config.authnRequestSignaturePolicy).toBe('required');
  });

  it('selects persistent NameID over transient when both are advertised to a strict publisher', () => {
    expect.hasAssertions();
    expect(
      selectSAMLSPNameIDFormat(
        {
          nameIdFormat: NAMEID_FORMATS.TRANSIENT,
          metadataNameIdFormats: [NAMEID_FORMATS.TRANSIENT, NAMEID_FORMATS.PERSISTENT],
        },
        { nameIdFormat: NAMEID_FORMATS.PERSISTENT }
      )
    ).toBe(NAMEID_FORMATS.PERSISTENT);
  });

  it('pins the GakuNin academic publisher OID bundle and required affiliation semantics', () => {
    expect.hasAssertions();
    const rules = buildAcademicPublisherAttributeReleaseRules();

    expect(rules.map((rule) => rule.name)).toEqual([
      ACADEMIC_PUBLISHER_ATTRIBUTES.mail.name,
      ACADEMIC_PUBLISHER_ATTRIBUTES.displayName.name,
      ACADEMIC_PUBLISHER_ATTRIBUTES.eduPersonScopedAffiliation.name,
      ACADEMIC_PUBLISHER_ATTRIBUTES.eduPersonEntitlement.name,
    ]);
    expect(
      rules.find((rule) => rule.name === ACADEMIC_PUBLISHER_ATTRIBUTES.mail.name)?.required
    ).toBe(true);
    expect(
      rules.find(
        (rule) => rule.name === ACADEMIC_PUBLISHER_ATTRIBUTES.eduPersonScopedAffiliation.name
      )?.required
    ).toBe(true);
    expect(
      rules.find((rule) => rule.name === ACADEMIC_PUBLISHER_ATTRIBUTES.eduPersonEntitlement.name)
        ?.required
    ).toBe(false);
  });

  it('pins the eduGAIN research collaboration OID bundle and multi-valued release fields', () => {
    expect.hasAssertions();
    const rules = buildResearchFederationAttributeReleaseRules();

    expect(rules.map((rule) => rule.name)).toEqual([
      RESEARCH_FEDERATION_ATTRIBUTES.mail.name,
      RESEARCH_FEDERATION_ATTRIBUTES.displayName.name,
      RESEARCH_FEDERATION_ATTRIBUTES.eduPersonPrincipalName.name,
      RESEARCH_FEDERATION_ATTRIBUTES.eduPersonScopedAffiliation.name,
      RESEARCH_FEDERATION_ATTRIBUTES.eduPersonEntitlement.name,
      RESEARCH_FEDERATION_ATTRIBUTES.eduPersonUniqueId.name,
    ]);
    expect(
      rules.find((rule) => rule.name === RESEARCH_FEDERATION_ATTRIBUTES.eduPersonPrincipalName.name)
        ?.required
    ).toBe(true);
    expect(
      rules.find(
        (rule) => rule.name === RESEARCH_FEDERATION_ATTRIBUTES.eduPersonScopedAffiliation.name
      )?.computed
    ).toBe('eduPersonScopedAffiliation');
  });

  it('fails closed for an unsigned eduGAIN-style aggregate under strict trust policy', () => {
    expect.hasAssertions();
    expect(() =>
      verifyAggregateMetadataSignature(
        ACADEMIC_AGGREGATE_METADATA,
        'https://metadata.example.edu/edugain.xml',
        [
          {
            id: 'academic-federation',
            name: 'Academic Federation',
            enabled: true,
            metadataUrlPatterns: ['https://metadata.example.edu/*.xml'],
            certificates: [],
          },
        ],
        'strict'
      )
    ).toThrow('Aggregate metadata root is not signed');
  });

  it('marks an unsigned aggregate unverified rather than trusted under warn policy', () => {
    expect.hasAssertions();
    const result = verifyAggregateMetadataSignature(
      ACADEMIC_AGGREGATE_METADATA,
      'https://metadata.example.edu/edugain.xml',
      [
        {
          id: 'academic-federation',
          name: 'Academic Federation',
          enabled: true,
          metadataUrlPatterns: ['https://metadata.example.edu/*.xml'],
          certificates: [],
        },
      ],
      'warn'
    );

    expect(result).toMatchObject({
      status: 'unverified',
      policy: 'warn',
      signedElementId: '_edugain_style_aggregate',
      trustProfileId: 'academic-federation',
      error: 'Aggregate metadata root is not signed',
    });
  });

  it('rejects an aggregate without a stable root ID', () => {
    expect.hasAssertions();
    const withoutId = ACADEMIC_AGGREGATE_METADATA.replace('ID="_edugain_style_aggregate" ', '');

    expect(() => parseAggregateMetadata(withoutId)).toThrow(
      'Invalid aggregate metadata: missing root ID'
    );
  });

  it('rejects selection of an entity that is not present in the trusted aggregate snapshot', () => {
    expect.hasAssertions();
    expect(() =>
      extractEntityDescriptorXml(
        ACADEMIC_AGGREGATE_METADATA,
        'https://attacker.example/not-in-aggregate'
      )
    ).toThrow(SAMLMetadataValidationError);
  });
});
