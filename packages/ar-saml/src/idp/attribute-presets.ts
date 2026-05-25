import type {
  SAMLAttributePresetId as CoreSAMLAttributePresetId,
  SAMLSPConfig,
} from '@authrim/ar-lib-core';
import type { SAMLAttributeReleaseRule } from './attributes';

export const SAML_ATTRIBUTE_NAME_FORMAT_URI = 'urn:oasis:names:tc:SAML:2.0:attrname-format:uri';
export const SAML_ATTRIBUTE_PRESET_VERSION = '2026-05-11';

export type SAMLAttributePresetId = CoreSAMLAttributePresetId;

export type SAMLAttributePresetProfile =
  | 'basic'
  | 'academic_publisher'
  | 'enterprise_saas'
  | 'research_federation';

interface SAMLAttributeDescriptor {
  name: string;
  friendlyName: string;
}

export const BASIC_ATTRIBUTES = {
  mail: {
    name: 'urn:oid:0.9.2342.19200300.100.1.3',
    friendlyName: 'mail',
  },
  displayName: {
    name: 'urn:oid:2.16.840.1.113730.3.1.241',
    friendlyName: 'displayName',
  },
} as const;

export function buildBasicAttributeReleaseRules(): SAMLAttributeReleaseRule[] {
  return [
    claimRule(BASIC_ATTRIBUTES.mail, 'email', true),
    claimRule(BASIC_ATTRIBUTES.displayName, 'name'),
  ];
}

export interface SAMLAttributePresetDefinition {
  id: SAMLAttributePresetId;
  version: string;
  profile: SAMLAttributePresetProfile;
  label: string;
  description: string;
  stability: 'experimental' | 'stable';
  applicationMode: 'clone_edit';
  buildRules: () => SAMLAttributeReleaseRule[];
}

export const ACADEMIC_PUBLISHER_ATTRIBUTES = {
  mail: {
    name: 'urn:oid:0.9.2342.19200300.100.1.3',
    friendlyName: 'mail',
  },
  displayName: {
    name: 'urn:oid:2.16.840.1.113730.3.1.241',
    friendlyName: 'displayName',
  },
  eduPersonScopedAffiliation: {
    name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.9',
    friendlyName: 'eduPersonScopedAffiliation',
  },
  eduPersonEntitlement: {
    name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.7',
    friendlyName: 'eduPersonEntitlement',
  },
  eduPersonAffiliation: {
    name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.1',
    friendlyName: 'eduPersonAffiliation',
  },
} as const;

export const ENTERPRISE_SAAS_ATTRIBUTES = {
  mail: {
    name: 'urn:oid:0.9.2342.19200300.100.1.3',
    friendlyName: 'mail',
  },
  displayName: {
    name: 'urn:oid:2.16.840.1.113730.3.1.241',
    friendlyName: 'displayName',
  },
  givenName: {
    name: 'urn:oid:2.5.4.42',
    friendlyName: 'givenName',
  },
  surname: {
    name: 'urn:oid:2.5.4.4',
    friendlyName: 'sn',
  },
  memberOf: {
    name: 'urn:oid:1.2.840.113556.1.2.102',
    friendlyName: 'memberOf',
  },
} as const;

export const RESEARCH_FEDERATION_ATTRIBUTES = {
  mail: {
    name: 'urn:oid:0.9.2342.19200300.100.1.3',
    friendlyName: 'mail',
  },
  displayName: {
    name: 'urn:oid:2.16.840.1.113730.3.1.241',
    friendlyName: 'displayName',
  },
  eduPersonPrincipalName: {
    name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.6',
    friendlyName: 'eduPersonPrincipalName',
  },
  eduPersonScopedAffiliation: {
    name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.9',
    friendlyName: 'eduPersonScopedAffiliation',
  },
  eduPersonEntitlement: {
    name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.7',
    friendlyName: 'eduPersonEntitlement',
  },
  eduPersonUniqueId: {
    name: 'urn:oid:1.3.6.1.4.1.5923.1.1.1.13',
    friendlyName: 'eduPersonUniqueId',
  },
} as const;

export interface AcademicPublisherAttributePresetOptions {
  affiliationClaim?: string;
  entitlementClaim?: string;
  affiliationRequired?: boolean;
  entitlementRequired?: boolean;
}

export function buildAcademicPublisherAttributeReleaseRules(
  options: AcademicPublisherAttributePresetOptions = {}
): SAMLAttributeReleaseRule[] {
  const affiliationClaim = options.affiliationClaim ?? 'eduPersonScopedAffiliation';
  const entitlementClaim = options.entitlementClaim ?? 'eduPersonEntitlement';

  return [
    claimRule(ACADEMIC_PUBLISHER_ATTRIBUTES.mail, 'email', true),
    claimRule(ACADEMIC_PUBLISHER_ATTRIBUTES.displayName, 'name'),
    computedRule(
      ACADEMIC_PUBLISHER_ATTRIBUTES.eduPersonScopedAffiliation,
      'eduPersonScopedAffiliation',
      affiliationClaim,
      options.affiliationRequired ?? true
    ),
    customClaimRule(
      ACADEMIC_PUBLISHER_ATTRIBUTES.eduPersonEntitlement,
      entitlementClaim,
      options.entitlementRequired ?? false
    ),
  ];
}

export interface EnterpriseSaaSAttributePresetOptions {
  givenNameClaim?: string;
  surnameClaim?: string;
  groupsClaim?: string;
  groupsAttributeName?: string;
  groupsFriendlyName?: string;
  groupsRequired?: boolean;
}

export function buildEnterpriseSaaSAttributeReleaseRules(
  options: EnterpriseSaaSAttributePresetOptions = {}
): SAMLAttributeReleaseRule[] {
  return [
    claimRule(ENTERPRISE_SAAS_ATTRIBUTES.mail, 'email', true),
    claimRule(ENTERPRISE_SAAS_ATTRIBUTES.displayName, 'name'),
    customClaimRule(ENTERPRISE_SAAS_ATTRIBUTES.givenName, options.givenNameClaim ?? 'givenName'),
    customClaimRule(ENTERPRISE_SAAS_ATTRIBUTES.surname, options.surnameClaim ?? 'surname'),
    customClaimRule(
      {
        ...ENTERPRISE_SAAS_ATTRIBUTES.memberOf,
        name: options.groupsAttributeName ?? ENTERPRISE_SAAS_ATTRIBUTES.memberOf.name,
        friendlyName:
          options.groupsFriendlyName ?? ENTERPRISE_SAAS_ATTRIBUTES.memberOf.friendlyName,
      },
      options.groupsClaim ?? 'groups',
      options.groupsRequired ?? false
    ),
  ];
}

export interface ResearchFederationAttributePresetOptions {
  principalNameClaim?: string;
  affiliationClaim?: string;
  entitlementClaim?: string;
  uniqueIdClaim?: string;
  principalNameRequired?: boolean;
  affiliationRequired?: boolean;
  uniqueIdRequired?: boolean;
}

export function buildResearchFederationAttributeReleaseRules(
  options: ResearchFederationAttributePresetOptions = {}
): SAMLAttributeReleaseRule[] {
  return [
    claimRule(RESEARCH_FEDERATION_ATTRIBUTES.mail, 'email', true),
    claimRule(RESEARCH_FEDERATION_ATTRIBUTES.displayName, 'name'),
    customClaimRule(
      RESEARCH_FEDERATION_ATTRIBUTES.eduPersonPrincipalName,
      options.principalNameClaim ?? 'eduPersonPrincipalName',
      options.principalNameRequired ?? true
    ),
    computedRule(
      RESEARCH_FEDERATION_ATTRIBUTES.eduPersonScopedAffiliation,
      'eduPersonScopedAffiliation',
      options.affiliationClaim ?? 'eduPersonScopedAffiliation',
      options.affiliationRequired ?? true
    ),
    customClaimRule(
      RESEARCH_FEDERATION_ATTRIBUTES.eduPersonEntitlement,
      options.entitlementClaim ?? 'eduPersonEntitlement'
    ),
    customClaimRule(
      RESEARCH_FEDERATION_ATTRIBUTES.eduPersonUniqueId,
      options.uniqueIdClaim ?? 'eduPersonUniqueId',
      options.uniqueIdRequired ?? false
    ),
  ];
}

export const SAML_BUILTIN_ATTRIBUTE_PRESETS: readonly SAMLAttributePresetDefinition[] = [
  {
    id: 'basic.v1',
    version: SAML_ATTRIBUTE_PRESET_VERSION,
    profile: 'basic',
    label: 'Basic Profile',
    description: 'Minimal email and display name attributes for common SAML service providers.',
    stability: 'stable',
    applicationMode: 'clone_edit',
    buildRules: buildBasicAttributeReleaseRules,
  },
  {
    id: 'academic_publisher.v1',
    version: SAML_ATTRIBUTE_PRESET_VERSION,
    profile: 'academic_publisher',
    label: 'Academic Publisher',
    description: 'Library consortium and academic publisher SAML attribute release template.',
    stability: 'experimental',
    applicationMode: 'clone_edit',
    buildRules: buildAcademicPublisherAttributeReleaseRules,
  },
  {
    id: 'enterprise_saas.v1',
    version: SAML_ATTRIBUTE_PRESET_VERSION,
    profile: 'enterprise_saas',
    label: 'Enterprise SaaS',
    description: 'Common workforce SSO attributes for SaaS service providers.',
    stability: 'experimental',
    applicationMode: 'clone_edit',
    buildRules: buildEnterpriseSaaSAttributeReleaseRules,
  },
  {
    id: 'research_federation.v1',
    version: SAML_ATTRIBUTE_PRESET_VERSION,
    profile: 'research_federation',
    label: 'Research Federation',
    description: 'Research collaboration attributes based on common eduPerson-style releases.',
    stability: 'experimental',
    applicationMode: 'clone_edit',
    buildRules: buildResearchFederationAttributeReleaseRules,
  },
] as const;

export function getSAMLAttributePreset(
  presetId: SAMLAttributePresetId
): SAMLAttributePresetDefinition {
  const preset = SAML_BUILTIN_ATTRIBUTE_PRESETS.find((item) => item.id === presetId);
  if (!preset) {
    throw new Error(`Unknown SAML attribute preset: ${presetId}`);
  }
  return preset;
}

export function cloneSAMLAttributeReleasePolicyFromPreset(presetId: SAMLAttributePresetId): {
  presetId: SAMLAttributePresetId;
  presetVersion: string;
  attributes: SAMLAttributeReleaseRule[];
} {
  const preset = getSAMLAttributePreset(presetId);
  return {
    presetId: preset.id,
    presetVersion: preset.version,
    attributes: preset.buildRules().map((rule) => ({ ...rule })),
  };
}

export function applySAMLAttributePresetToSPConfig(
  config: SAMLSPConfig,
  presetId: SAMLAttributePresetId
): SAMLSPConfig {
  const cloned = cloneSAMLAttributeReleasePolicyFromPreset(presetId);
  return {
    ...config,
    attributePresetId: cloned.presetId,
    attributePresetVersion: cloned.presetVersion,
    attributeReleasePolicy: {
      attributes: cloned.attributes,
    },
  };
}

export function normalizeSAMLSPAttributePresetConfig(config: SAMLSPConfig): SAMLSPConfig {
  if (!config.attributePresetId) {
    return config;
  }

  if (config.attributePresetId.startsWith('custom:')) {
    return config;
  }

  if (!config.attributeReleasePolicy) {
    return applySAMLAttributePresetToSPConfig(config, config.attributePresetId);
  }

  const preset = getSAMLAttributePreset(config.attributePresetId);
  return {
    ...config,
    attributePresetVersion: config.attributePresetVersion ?? preset.version,
  };
}

function claimRule(
  attribute: SAMLAttributeDescriptor,
  claim: string,
  required = false
): SAMLAttributeReleaseRule {
  return {
    name: attribute.name,
    friendlyName: attribute.friendlyName,
    nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
    source: 'claim',
    claim,
    required,
  };
}

function customClaimRule(
  attribute: SAMLAttributeDescriptor,
  claim: string,
  required = false
): SAMLAttributeReleaseRule {
  return {
    name: attribute.name,
    friendlyName: attribute.friendlyName,
    nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
    source: 'custom_claim',
    claim,
    required,
  };
}

function computedRule(
  attribute: SAMLAttributeDescriptor,
  computed: SAMLAttributeReleaseRule['computed'],
  directClaim: string,
  required = false
): SAMLAttributeReleaseRule {
  return {
    name: attribute.name,
    friendlyName: attribute.friendlyName,
    nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
    source: 'computed',
    computed,
    claim: directClaim,
    required,
  };
}
