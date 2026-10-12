/**
 * The identity mapping a SAML SP releases attributes through, as the SSO endpoints read it.
 *
 * An SP that names only a Field Mapping Set (`identityMapping.fieldMappingSetId`) gets the active
 * binding of that set from the control plane. The catalog that binding carries is the compiled
 * snapshot's: the tenant's canonical fields, with no entry for the SAML attributes a mapping
 * releases to. The mapping runtime drops a mapped value whose destination has no catalog entry, so
 * without one every attribute is lost. The SP's release policy lists exactly the fields of its
 * Destination Profile (the Admin API enforces it), so each of those becomes a destination-only
 * entry here: the allow-list the runtime checks against.
 *
 * Two more things are settled here, because they decide what is released:
 * - the fields of the snapshot's catalog are the tenant's, so the sources' classification can be
 *   told (the release is refused for a source it cannot be told for; see
 *   assertRuntimeIdentityMappingReleaseSafety): the stored default canonical fields come with the
 *   binding, the tenant's own fields are added here;
 * - an attribute descriptor may not give an attribute a name other than its Destination Profile
 *   field's: the release policy and the classification check are by field, and a renamed
 *   attribute would be judged as another field.
 */

import type { Env, SAMLSPConfig } from '@authrim/ar-lib-core';
import {
  isVirtualCanonicalCatalogVersion,
  loadCustomClaimSchemaCatalogEntries,
  loadDestinationProfileConsentDescriptor,
  mergeCanonicalCatalogEntries,
  requireAdminDatabaseAdapter,
  resolveAuthCorePersistenceAdapterFromEnv,
  resolveRuntimeIdentityMappingBinding,
  sliceOutputGraph,
  type DestinationProfileConsentField,
} from '@authrim/ar-lib-core';
import {
  SAMLIdentityMappingRuntimeError,
  type SAMLIdentityMappingReleaseConfig,
} from './attributes';

const DEFAULT_DESTINATION_NAMESPACE = 'saml.attribute';

const CLASSIFICATIONS = new Set([
  'public',
  'internal',
  'pii',
  'secret',
  'regulated',
  'credential',
  'token',
  'key_material',
]);

type CatalogEntries = NonNullable<SAMLIdentityMappingReleaseConfig['catalog']>['entries'];

/**
 * The catalog entries to add for the destination attributes of an SP: one per field of its
 * release policy that its Destination Profile lists, unless the catalog already has one.
 */
export function destinationCatalogEntries(input: {
  namespace: string;
  policyKeys: readonly string[];
  profileFields: readonly Pick<
    DestinationProfileConsentField,
    'key' | 'classification' | 'valueMultiplicity'
  >[];
  existing: CatalogEntries;
}): CatalogEntries {
  const known = new Set(input.existing.map((entry) => `${entry.namespace}:${entry.path}`));
  const knownIds = new Set(input.existing.map((entry) => entry.id));
  const fieldsByKey = new Map(input.profileFields.map((field) => [field.key, field]));
  const added: CatalogEntries = [];
  for (const key of new Set(input.policyKeys)) {
    const field = fieldsByKey.get(key);
    const alias = `${input.namespace}:${key}`;
    const id = `dest.saml.${key}`;
    if (!field || known.has(alias) || knownIds.has(id)) continue;
    added.push({
      id,
      namespace: input.namespace,
      path: key,
      valueType: 'string',
      cardinality: field.valueMultiplicity === 'multi' ? 'multi' : 'single',
      classification: (CLASSIFICATIONS.has(field.classification)
        ? field.classification
        : 'internal') as CatalogEntries[number]['classification'],
      targetType: 'destination-only',
    });
  }
  return added;
}

/** The destination keys whose attribute descriptor names the attribute otherwise than the field. */
export function findRenamedAttributeDescriptors(
  targets: ReadonlyArray<{ namespace: string; path: string; catalogEntryId?: string }>,
  descriptors: Record<string, { name?: string; friendlyName?: string }> | undefined
): string[] {
  if (!descriptors) return [];
  const renamed = new Set<string>();
  for (const target of targets) {
    // Own keys only: a field may be named constructor or toString.
    const own = (key: string) => (Object.hasOwn(descriptors, key) ? descriptors[key] : undefined);
    const descriptor =
      (target.catalogEntryId ? own(target.catalogEntryId) : undefined) ??
      own(target.path) ??
      own(`${target.namespace}:${target.path}`);
    if (descriptor?.name !== undefined && descriptor.name !== target.path) {
      renamed.add(target.path);
    }
  }
  return [...renamed];
}

export async function resolveSAMLRuntimeIdentityMapping(
  env: Env,
  tenantId: string,
  idpEntityId: string,
  spConfig: SAMLSPConfig
): Promise<SAMLIdentityMappingReleaseConfig | undefined> {
  const configured = spConfig.identityMapping as SAMLIdentityMappingReleaseConfig | undefined;
  if (configured?.catalog || configured?.defaultBinding || configured?.bindings?.length) {
    return configured;
  }

  const adapter = requireAdminDatabaseAdapter(env, 'saml-identity-mapping');
  const binding = await resolveRuntimeIdentityMappingBinding(adapter, {
    tenantId,
    protocol: 'saml',
    role: 'idp',
    fieldMappingSetId: configured?.fieldMappingSetId,
    localEntityId: idpEntityId,
    partnerEntityId: spConfig.entityId,
    // The release judges each source by its classification: it needs the catalog's entries.
    resolveCanonicalCatalog: true,
  });
  if (!binding) {
    throw new SAMLIdentityMappingRuntimeError([
      {
        category: 'policy',
        code: 'policy.missing_identity_mapping_binding',
        severity: 'critical',
      },
    ]);
  }
  if (binding.destinationProfileIds.length !== 1 || !binding.destinationProfileId) {
    throw new SAMLIdentityMappingRuntimeError([
      {
        category: 'policy',
        code: 'policy.invalid_destination_profile_binding',
        severity: 'critical',
      },
    ]);
  }

  const destinationNamespace =
    configured?.destinationNamespace ?? binding.destinationNamespace ?? undefined;
  // A set holds the rules of both directions (a source profile's fields into the canonical ones,
  // and the canonical ones out to a destination). The SAML IdP runs its own: only these edges
  // (the transforms that make their values, and the validation rules on the fields they use) are read for values, executed and judged for
  // release, all from this one cut.
  const outputGraph = sliceOutputGraph({
    edges: binding.edges,
    transforms: binding.transforms,
    validationRules: binding.validationRules,
    destinationNamespace: destinationNamespace ?? DEFAULT_DESTINATION_NAMESPACE,
  });

  const renamed = findRenamedAttributeDescriptors(
    [
      ...outputGraph.edges.map((edge) => edge.targetRef),
      ...outputGraph.transforms.map((t) => t.outputTargetRef),
    ],
    configured?.attributeDescriptors
  );
  if (renamed.length > 0) {
    throw new SAMLIdentityMappingRuntimeError([
      {
        category: 'policy',
        code: 'policy.attribute_descriptor_renames_field',
        severity: 'critical',
      },
    ]);
  }

  const policyKeys = Object.keys(configured?.destinationFieldPolicies ?? {});
  let catalog = binding.catalog;
  if (isVirtualCanonicalCatalogVersion(catalog.identity?.id ?? '')) {
    // The tenant's own fields: where the control plane compiled the snapshot's catalog from.
    const coreAdapter = await resolveAuthCorePersistenceAdapterFromEnv(
      env,
      'saml-canonical-catalog',
      { tenantId }
    );
    catalog = {
      ...catalog,
      entries: mergeCanonicalCatalogEntries(
        catalog.entries,
        await loadCustomClaimSchemaCatalogEntries(coreAdapter, tenantId)
      ),
    };
  }
  if (policyKeys.length > 0) {
    const descriptor = await loadDestinationProfileConsentDescriptor(
      adapter,
      tenantId,
      binding.destinationProfileId
    );
    const added = descriptor
      ? destinationCatalogEntries({
          namespace: destinationNamespace ?? DEFAULT_DESTINATION_NAMESPACE,
          policyKeys,
          profileFields: descriptor.fields,
          existing: catalog.entries,
        })
      : [];
    if (added.length > 0) {
      catalog = { ...catalog, entries: [...catalog.entries, ...added] };
    }
  }

  return {
    id: binding.id,
    role: 'idp',
    tenantId: binding.tenantId,
    localEntityId: idpEntityId,
    partnerEntityId: spConfig.entityId,
    catalog,
    edges: outputGraph.edges,
    transforms: outputGraph.transforms,
    validationRules: outputGraph.validationRules,
    fieldMappingSet: binding.fieldMappingSet,
    destinationNamespace,
    attributeDescriptors: configured?.attributeDescriptors,
    destinationFieldPolicies: configured?.destinationFieldPolicies,
    fieldMappingSetId: binding.fieldMappingSetId,
    fieldMappingVersionId: binding.fieldMappingVersionId,
    sourceProfileId: configured?.sourceProfileId ?? binding.sourceProfileId,
    destinationProfileId: binding.destinationProfileId ?? configured?.destinationProfileId,
  };
}
