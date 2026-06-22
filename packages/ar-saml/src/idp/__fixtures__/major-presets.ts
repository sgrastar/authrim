import type { SAMLAttributeReleaseConfig, SAMLAttributeSubject } from '../attributes';
import type { FieldCatalogEntry, TargetType } from '@authrim/ar-lib-field-mapping';
import type { SAMLIdentityMappingReleaseConfig } from '../attributes';
import { SAML_ATTRIBUTE_NAME_FORMAT_URI } from '../attribute-presets';

export const enterpriseSaaSSubjectFixture: SAMLAttributeSubject = {
  id: 'user-456',
  email: 'employee@example.com',
  name: 'Employee Example',
  customClaims: {
    givenName: 'Employee',
    surname: 'Example',
    groups: ['finance', 'workspace-admins'],
  },
};

export const enterpriseSaaSAttributeReleaseConfigFixture: SAMLAttributeReleaseConfig = {
  attributeMapping: {},
  identityMapping: buildIdentityMappingConfig([
    ['email', 'authrim.profile', 'email', 'mail', 'urn:oid:0.9.2342.19200300.100.1.3'],
    ['name', 'authrim.profile', 'name', 'displayName', 'urn:oid:2.16.840.1.113730.3.1.241'],
    ['givenName', 'authrim.custom_claims', 'givenName', 'givenName', 'urn:oid:2.5.4.42'],
    ['surname', 'authrim.custom_claims', 'surname', 'sn', 'urn:oid:2.5.4.4'],
    ['groups', 'authrim.custom_claims', 'groups', 'memberOf', 'urn:oid:1.2.840.113556.1.2.102'],
  ]),
};

export const researchFederationSubjectFixture: SAMLAttributeSubject = {
  id: 'user-789',
  email: 'researcher@example.edu',
  name: 'Researcher Example',
  customClaims: {
    eduPersonPrincipalName: 'researcher@example.edu',
    eduPersonScopedAffiliation: ['faculty@example.edu', 'member@example.edu'],
    eduPersonEntitlement: ['urn:mace:example.edu:entitlement:research-platform'],
    eduPersonUniqueId: 'researcher-789@example.edu',
  },
};

export const researchFederationAttributeReleaseConfigFixture: SAMLAttributeReleaseConfig = {
  attributeMapping: {},
  identityMapping: buildIdentityMappingConfig([
    ['email', 'authrim.profile', 'email', 'mail', 'urn:oid:0.9.2342.19200300.100.1.3'],
    ['name', 'authrim.profile', 'name', 'displayName', 'urn:oid:2.16.840.1.113730.3.1.241'],
    [
      'eppn',
      'authrim.custom_claims',
      'eduPersonPrincipalName',
      'eduPersonPrincipalName',
      'urn:oid:1.3.6.1.4.1.5923.1.1.1.6',
    ],
    [
      'affiliation',
      'authrim.custom_claims',
      'eduPersonScopedAffiliation',
      'eduPersonScopedAffiliation',
      'urn:oid:1.3.6.1.4.1.5923.1.1.1.9',
    ],
    [
      'entitlement',
      'authrim.custom_claims',
      'eduPersonEntitlement',
      'eduPersonEntitlement',
      'urn:oid:1.3.6.1.4.1.5923.1.1.1.7',
    ],
    [
      'uniqueId',
      'authrim.custom_claims',
      'eduPersonUniqueId',
      'eduPersonUniqueId',
      'urn:oid:1.3.6.1.4.1.5923.1.1.1.13',
    ],
  ]),
};

type MappingSpec = [
  id: string,
  sourceNamespace: string,
  sourcePath: string,
  friendlyName: string,
  targetPath: string,
];

export function buildIdentityMappingConfig(specs: MappingSpec[]): SAMLIdentityMappingReleaseConfig {
  return {
    catalog: {
      identity: {
        id: 'major-preset-test-catalog',
        version: '1',
        contentHash: 'major-preset-test-catalog',
        compatibilityRange: '^0.3.0',
      },
      entries: [
        ...specs.map(([, namespace, path]) =>
          entry(`source.${namespace}.${path}`, namespace, path, 'canonical')
        ),
        ...specs.map(([, , , friendlyName, path]) =>
          entry(`target.${friendlyName}`, 'saml.attribute', path, 'destination-only')
        ),
      ],
    },
    edges: specs.map(([id, sourceNamespace, sourcePath, friendlyName, targetPath]) => ({
      id: `edge.${id}`,
      sourceRef: {
        side: 'source' as const,
        namespace: sourceNamespace,
        path: sourcePath,
      },
      targetRef: {
        side: 'destination' as const,
        namespace: 'saml.attribute',
        path: targetPath,
        catalogEntryId: `target.${friendlyName}`,
      },
      edgeKind: 'direct',
    })),
    attributeDescriptors: Object.fromEntries(
      specs.map(([, , , friendlyName]) => [
        `target.${friendlyName}`,
        {
          friendlyName,
          nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
        },
      ])
    ),
  };
}

function entry(
  id: string,
  namespace: string,
  path: string,
  targetType: TargetType
): FieldCatalogEntry {
  return {
    id,
    namespace,
    path,
    valueType: 'string',
    cardinality: 'single' as const,
    classification: 'pii' as const,
    targetType,
  };
}
