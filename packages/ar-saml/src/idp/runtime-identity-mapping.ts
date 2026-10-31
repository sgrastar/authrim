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

import type {
  Env,
  SAMLIdentityMappingFieldMappingSelector,
  SAMLSPConfig,
} from '@authrim/ar-lib-core';
import type { DatabaseAdapter } from '@authrim/ar-lib-core/db/adapter';
import type { SAMLRuntimeImportedSPRelease } from '@authrim/ar-lib-core/types/saml-runtime-ports';
import {
  findRenamedAttributeDescriptors,
  isVirtualCanonicalCatalogVersion,
  loadCustomClaimSchemaCatalogEntries,
  loadDestinationProfileConsentDescriptor,
  mergeCanonicalCatalogEntries,
  requireAdminDatabaseAdapter,
  resolveAuthCorePersistenceAdapterFromEnv,
  resolveRuntimeIdentityMappingBinding,
  samlDestinationPolicyCoversProfile,
  findRenamedOutputAttributes,
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

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const item = record(value);
  if (item) {
    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Validate a verified Admin export again against the selected SP before every release. */
export function assertSAMLImportedSPRelease(
  release: SAMLRuntimeImportedSPRelease | null,
  context: {
    tenantId: string;
    spEntityId: string;
    idpEntityId?: string;
    sourceSelector?: SAMLIdentityMappingFieldMappingSelector;
  }
): SAMLIdentityMappingReleaseConfig {
  const binding = record(release?.binding);
  const catalog = record(binding?.catalog);
  const identity = record(catalog?.identity);
  const fieldMappingSet = record(binding?.fieldMappingSet);
  const sourceRef = release?.sourceBindingRef;
  const profile = release?.destinationProfile;
  if (
    !release ||
    release.tenantId !== context.tenantId ||
    release.entityId !== context.spEntityId ||
    canonicalJson(release.sourceSelector) !== canonicalJson(context.sourceSelector ?? null) ||
    !sourceRef?.activationId ||
    !sourceRef.fieldMappingSetId ||
    !sourceRef.fieldMappingVersionId ||
    !sourceRef.mappingSnapshotHash ||
    !sourceRef.destinationProfileId ||
    !sourceRef.destinationProfileVersionId ||
    !binding ||
    binding.bindings !== undefined ||
    binding.defaultBinding !== undefined ||
    binding.id !== sourceRef.activationId ||
    binding.fieldMappingSetId !== sourceRef.fieldMappingSetId ||
    binding.fieldMappingVersionId !== sourceRef.fieldMappingVersionId ||
    binding.mappingSnapshotHash !== sourceRef.mappingSnapshotHash ||
    binding.role !== 'idp' ||
    binding.tenantId !== context.tenantId ||
    binding.partnerEntityId !== context.spEntityId ||
    typeof binding.localEntityId !== 'string' ||
    !binding.localEntityId ||
    (context.idpEntityId !== undefined && binding.localEntityId !== context.idpEntityId) ||
    binding.destinationProfileId !== sourceRef.destinationProfileId ||
    !Array.isArray(binding.destinationProfileIds) ||
    binding.destinationProfileIds.length !== 1 ||
    binding.destinationProfileIds[0] !== sourceRef.destinationProfileId ||
    !catalog ||
    !identity?.id ||
    !identity.contentHash ||
    !Array.isArray(catalog.entries) ||
    !Array.isArray(binding.edges) ||
    !Array.isArray(binding.transforms) ||
    !Array.isArray(binding.validationRules) ||
    !fieldMappingSet ||
    fieldMappingSet.id !== sourceRef.fieldMappingVersionId ||
    !Array.isArray(fieldMappingSet.rules) ||
    profile?.destinationType !== 'saml' ||
    profile.profileId !== sourceRef.destinationProfileId ||
    profile.profileVersionId !== sourceRef.destinationProfileVersionId ||
    !Array.isArray(profile.fields) ||
    profile.fields.some((field) => !field.key || !CLASSIFICATIONS.has(field.classification)) ||
    new Set(profile.fields.map((field) => field.key)).size !== profile.fields.length ||
    binding.transforms.some(
      (transform) => record(transform)?.operation === 'saml_edu_person_targeted_id'
    ) ||
    (context.sourceSelector?.fieldMappingSetId !== undefined &&
      context.sourceSelector.fieldMappingSetId !== sourceRef.fieldMappingSetId) ||
    (context.sourceSelector?.fieldMappingVersionId !== undefined &&
      context.sourceSelector.fieldMappingVersionId !== sourceRef.fieldMappingVersionId) ||
    (context.sourceSelector?.sourceProfileId !== undefined &&
      binding.sourceProfileId !== context.sourceSelector.sourceProfileId) ||
    (context.sourceSelector?.destinationProfileId !== undefined &&
      context.sourceSelector.destinationProfileId !== sourceRef.destinationProfileId) ||
    canonicalJson(binding.destinationFieldPolicies ?? {}) !==
      canonicalJson(context.sourceSelector?.destinationFieldPolicies ?? {}) ||
    canonicalJson(binding.attributeDescriptors ?? {}) !==
      canonicalJson(context.sourceSelector?.attributeDescriptors ?? {}) ||
    (context.sourceSelector?.destinationNamespace !== undefined &&
      binding.destinationNamespace !== context.sourceSelector.destinationNamespace)
  ) {
    throw new Error('saml_idp_runtime_imported_release_invalid');
  }
  const compiled = binding as SAMLIdentityMappingReleaseConfig;
  const policies = compiled.destinationFieldPolicies ?? {};
  if (
    !samlDestinationPolicyCoversProfile(
      Object.keys(policies),
      profile.fields.map((field) => field.key)
    ) ||
    Object.values(policies).some((value) => !['required', 'optional', 'hidden'].includes(value)) ||
    findRenamedOutputAttributes(
      { edges: compiled.edges ?? [], transforms: compiled.transforms ?? [] },
      compiled.destinationNamespace ?? DEFAULT_DESTINATION_NAMESPACE,
      compiled.attributeDescriptors
    ).length > 0
  ) {
    throw new Error('saml_idp_runtime_imported_release_invalid');
  }
  return compiled;
}

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

export { findRenamedAttributeDescriptors };

export async function resolveSAMLRuntimeIdentityMapping(
  env: Env,
  tenantId: string,
  idpEntityId: string,
  spConfig: SAMLSPConfig
): Promise<SAMLIdentityMappingReleaseConfig | undefined> {
  const configured = spConfig.identityMapping as SAMLIdentityMappingReleaseConfig | undefined;
  if (env.SAML_RUNTIME_PORTS) {
    return assertSAMLImportedSPRelease(
      env.SAML_RUNTIME_PORTS.serviceProviders.getRelease({ tenantId, entityId: spConfig.entityId }),
      {
        tenantId,
        spEntityId: spConfig.entityId,
        idpEntityId,
        sourceSelector: spConfig.identityMapping,
      }
    );
  }
  if (configured?.catalog || configured?.defaultBinding || configured?.bindings?.length) {
    return configured;
  }

  const adapter = requireAdminDatabaseAdapter(env, 'saml-identity-mapping');
  const compiled = await compileSAMLRuntimeIdentityMappingFromAdapters({
    adminAdapter: adapter,
    loadCoreAdapter: () =>
      resolveAuthCorePersistenceAdapterFromEnv(env, 'saml-canonical-catalog', { tenantId }),
    tenantId,
    idpEntityId,
    spConfig,
  });
  return compiled.runtime;
}

/** Reuses the CF issuance compiler against an isolated, verified Admin snapshot. */
async function compileSAMLRuntimeIdentityMappingFromAdapters(input: {
  adminAdapter: DatabaseAdapter;
  loadCoreAdapter: () => Promise<DatabaseAdapter>;
  tenantId: string;
  idpEntityId: string;
  spConfig: SAMLSPConfig;
}) {
  const { adminAdapter: adapter, tenantId, idpEntityId, spConfig } = input;
  const configured = spConfig.identityMapping as SAMLIdentityMappingReleaseConfig | undefined;
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
    const coreAdapter = await input.loadCoreAdapter();
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

  const runtime: SAMLIdentityMappingReleaseConfig = {
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
  return { runtime, sourceBinding: binding };
}

/** Compile one SP release from source settings using the same code path as CF issuance. */
export async function compileSAMLImportedSPRelease(input: {
  adminAdapter: DatabaseAdapter;
  coreAdapter: DatabaseAdapter;
  tenantId: string;
  idpEntityId: string;
  spConfig: SAMLSPConfig;
}): Promise<SAMLRuntimeImportedSPRelease> {
  const { tenantId, idpEntityId, spConfig } = input;
  const configured = spConfig.identityMapping as SAMLIdentityMappingReleaseConfig | undefined;
  if (configured?.catalog || configured?.defaultBinding || configured?.bindings?.length) {
    throw new Error('saml_idp_runtime_imported_release_invalid');
  }
  const compiled = await compileSAMLRuntimeIdentityMappingFromAdapters({
    adminAdapter: input.adminAdapter,
    loadCoreAdapter: async () => input.coreAdapter,
    tenantId,
    idpEntityId,
    spConfig,
  });
  const profileId = compiled.sourceBinding.destinationProfileId;
  if (!profileId) throw new Error('saml_idp_runtime_imported_release_invalid');
  const destinationProfile = await loadDestinationProfileConsentDescriptor(
    input.adminAdapter,
    tenantId,
    profileId
  );
  if (!destinationProfile) throw new Error('saml_idp_runtime_imported_release_invalid');
  const release: SAMLRuntimeImportedSPRelease = {
    tenantId,
    entityId: spConfig.entityId,
    sourceSelector: spConfig.identityMapping ?? null,
    sourceBindingRef: {
      activationId: compiled.sourceBinding.id,
      fieldMappingSetId: compiled.sourceBinding.fieldMappingSetId,
      fieldMappingVersionId: compiled.sourceBinding.fieldMappingVersionId,
      mappingSnapshotHash: compiled.sourceBinding.mappingSnapshotHash,
      destinationProfileId: profileId,
      destinationProfileVersionId: destinationProfile.profileVersionId,
    },
    binding: {
      ...compiled.runtime,
      mappingSnapshotHash: compiled.sourceBinding.mappingSnapshotHash,
      destinationProfileIds: compiled.sourceBinding.destinationProfileIds,
    },
    destinationProfile,
  };
  assertSAMLImportedSPRelease(release, {
    tenantId,
    spEntityId: spConfig.entityId,
    idpEntityId,
    sourceSelector: spConfig.identityMapping,
  });
  return release;
}
