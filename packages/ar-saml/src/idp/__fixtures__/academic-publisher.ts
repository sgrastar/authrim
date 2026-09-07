import type { SAMLAttributeReleaseConfig, SAMLAttributeSubject } from '../attributes';
import type { FieldCatalogEntry, TargetType } from '@authrim/ar-lib-field-mapping/contract';
import { SAML_ATTRIBUTE_NAME_FORMAT_URI } from '../attribute-presets';

export const academicPublisherSubjectFixture: SAMLAttributeSubject = {
  id: 'user-123',
  email: 'reader@example.edu',
  name: 'Reader Example',
  customClaims: {
    eduPersonScopedAffiliation: ['member@example.edu', 'staff@example.edu'],
    eduPersonEntitlement: ['urn:mace:dir:entitlement:common-lib-terms'],
  },
};

export const academicPublisherAttributeReleaseConfigFixture: SAMLAttributeReleaseConfig = {
  attributeMapping: {},
  identityMapping: {
    catalog: {
      identity: {
        id: 'academic-publisher-test-catalog',
        version: '1',
        contentHash: 'academic-publisher-test-catalog',
        compatibilityRange: '^0.3.0',
      },
      entries: [
        entry('source.email', 'authrim.profile', 'email', 'canonical'),
        entry('source.name', 'authrim.profile', 'name', 'canonical'),
        entry(
          'source.eduPersonScopedAffiliation',
          'authrim.custom_claims',
          'eduPersonScopedAffiliation',
          'custom'
        ),
        entry(
          'source.eduPersonEntitlement',
          'authrim.custom_claims',
          'eduPersonEntitlement',
          'custom'
        ),
        entry(
          'target.mail',
          'saml.attribute',
          'urn:oid:0.9.2342.19200300.100.1.3',
          'destination-only'
        ),
        entry(
          'target.displayName',
          'saml.attribute',
          'urn:oid:2.16.840.1.113730.3.1.241',
          'destination-only'
        ),
        entry(
          'target.eduPersonScopedAffiliation',
          'saml.attribute',
          'urn:oid:1.3.6.1.4.1.5923.1.1.1.9',
          'destination-only'
        ),
        entry(
          'target.eduPersonEntitlement',
          'saml.attribute',
          'urn:oid:1.3.6.1.4.1.5923.1.1.1.7',
          'destination-only'
        ),
      ],
    },
    edges: [
      edge('email', 'authrim.profile', 'email', 'mail', 'urn:oid:0.9.2342.19200300.100.1.3'),
      edge('name', 'authrim.profile', 'name', 'displayName', 'urn:oid:2.16.840.1.113730.3.1.241'),
      edge(
        'affiliation',
        'authrim.custom_claims',
        'eduPersonScopedAffiliation',
        'eduPersonScopedAffiliation',
        'urn:oid:1.3.6.1.4.1.5923.1.1.1.9'
      ),
      edge(
        'entitlement',
        'authrim.custom_claims',
        'eduPersonEntitlement',
        'eduPersonEntitlement',
        'urn:oid:1.3.6.1.4.1.5923.1.1.1.7'
      ),
    ],
    attributeDescriptors: {
      'target.mail': descriptor('mail'),
      'target.displayName': descriptor('displayName'),
      'target.eduPersonScopedAffiliation': descriptor('eduPersonScopedAffiliation'),
      'target.eduPersonEntitlement': descriptor('eduPersonEntitlement'),
    },
  },
};

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

function edge(
  id: string,
  sourceNamespace: string,
  sourcePath: string,
  targetFriendlyName: string,
  targetPath: string
) {
  return {
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
      catalogEntryId: `target.${targetFriendlyName}`,
    },
    edgeKind: 'direct',
  };
}

function descriptor(friendlyName: string) {
  return {
    friendlyName,
    nameFormat: SAML_ATTRIBUTE_NAME_FORMAT_URI,
  };
}
