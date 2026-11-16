/** Synthetic imported release shared by socket-free and PostgreSQL SAML regression tests. */
import type { SAMLRuntimeImportedSPRelease } from '@authrim/ar-lib-core/types/saml-runtime-ports';
import type { SAMLIdentityMappingFieldMappingBinding } from '../../../ar-saml/src/idp/attributes';

export const SP = 'https://sp.example.test/entity';
export const MAIL_ATTRIBUTE = 'urn:oid:0.9.2342.19200300.100.1.3';

export function importedMailRelease(
  tenantId: string,
  origin: string
): SAMLRuntimeImportedSPRelease {
  const fieldMappingSetId = `mapping-set-${tenantId}`;
  const fieldMappingVersionId = `mapping-version-${tenantId}`;
  const destinationProfileId = `destination-profile-${tenantId}`;
  const destinationProfileVersionId = `destination-version-${tenantId}`;
  const sourceSelector: NonNullable<SAMLRuntimeImportedSPRelease['sourceSelector']> = {
    fieldMappingSetId,
    fieldMappingVersionId,
    destinationProfileId,
    destinationFieldPolicies: { [MAIL_ATTRIBUTE]: 'required' },
  };
  const edge = {
    id: `edge-mail-${tenantId}`,
    sourceRef: {
      side: 'source',
      namespace: 'authrim.profile',
      path: 'email',
      catalogEntryId: 'source.email',
    },
    targetRef: {
      side: 'destination',
      namespace: 'saml.attribute',
      path: MAIL_ATTRIBUTE,
      catalogEntryId: 'destination.mail',
    },
  } satisfies SAMLIdentityMappingFieldMappingBinding['edges'][number];
  return {
    tenantId,
    entityId: SP,
    sourceSelector,
    sourceBindingRef: {
      activationId: `activation-${tenantId}`,
      fieldMappingSetId,
      fieldMappingVersionId,
      mappingSnapshotHash: `snapshot-hash-${tenantId}`,
      destinationProfileId,
      destinationProfileVersionId,
    },
    binding: {
      id: `activation-${tenantId}`,
      role: 'idp',
      tenantId,
      localEntityId: `${origin}/saml/idp/metadata`,
      partnerEntityId: SP,
      fieldMappingSetId,
      fieldMappingVersionId,
      mappingSnapshotHash: `snapshot-hash-${tenantId}`,
      destinationProfileId,
      destinationProfileIds: [destinationProfileId],
      destinationFieldPolicies: sourceSelector.destinationFieldPolicies,
      catalog: {
        identity: {
          id: `catalog-${tenantId}`,
          version: '1',
          contentHash: `catalog-hash-${tenantId}`,
          compatibilityRange: '*',
        },
        entries: [
          {
            id: 'source.email',
            namespace: 'authrim.profile',
            path: 'email',
            valueType: 'string',
            cardinality: 'single',
            classification: 'pii',
            targetType: 'canonical',
          },
          {
            id: 'destination.mail',
            namespace: 'saml.attribute',
            path: MAIL_ATTRIBUTE,
            valueType: 'string',
            cardinality: 'single',
            classification: 'pii',
            targetType: 'destination-only',
          },
        ],
      },
      edges: [edge],
      graphRules: [
        {
          id: `rule-mail-${tenantId}`,
          targetRef: edge.targetRef,
          edges: [edge],
          transforms: [],
          output: { edgeIndex: 0 },
        },
      ],
      transforms: [],
      validationRules: [],
      fieldMappingSet: { id: fieldMappingVersionId, rules: [] },
    },
    destinationProfile: {
      profileId: destinationProfileId,
      profileVersionId: destinationProfileVersionId,
      destinationType: 'saml',
      fields: [
        {
          key: MAIL_ATTRIBUTE,
          label: 'mail',
          required: false,
          nullable: false,
          classification: 'pii',
          surfaces: [],
          requiredScopes: [],
          valueType: 'string',
          valueMultiplicity: 'single',
          allowedValues: [],
        },
      ],
    },
  };
}
