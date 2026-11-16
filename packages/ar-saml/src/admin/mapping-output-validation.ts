import {
  isOutputGraphTarget,
  mappingReferenceProfileId,
  mappingSourceSubjectPath,
  type RuntimeIdentityMappingBinding,
} from '@authrim/ar-lib-core';
import type { FieldCatalogBundle, FieldRef } from '@authrim/ar-lib-field-mapping/contract';
import { findCatalogEntry } from '@authrim/ar-lib-field-mapping/runtime';

function isCanonicalInput(catalog: FieldCatalogBundle | undefined, target: FieldRef): boolean {
  // A profile reference is never proof of a canonical input, including its stored snake case form.
  const profileId = mappingReferenceProfileId({ ...target });
  if (!catalog || profileId || isOutputGraphTarget(target)) return false;
  const entry = findCatalogEntry(catalog, target);
  if (entry?.targetType !== 'canonical') return false;

  // Use the runtime's ID/alias lookup, but do not let a canonical ID disguise a different output.
  const byPlace = findCatalogEntry(catalog, { namespace: target.namespace, path: target.path });
  if (byPlace) return byPlace.id === entry.id;

  // Older editor references use authrim.profile for the seeded authrim.canonical fields. Both
  // must still name the same catalogued canonical field, as the runtime's subject reader does.
  const legacyProfile = (namespace: string) =>
    namespace === 'authrim.profile' || namespace === 'authrim.canonical';
  return (
    Boolean(target.catalogEntryId) &&
    legacyProfile(target.namespace) &&
    legacyProfile(entry.namespace) &&
    mappingSourceSubjectPath(target) === mappingSourceSubjectPath(entry)
  );
}

/** Judge final releases, rather than the input rules or intermediate values in their graphs. */
export function hasNonSAMLMappingOutput(
  binding: Pick<
    RuntimeIdentityMappingBinding,
    'graphRules' | 'edges' | 'transforms' | 'catalog' | 'storedProfileTargets'
  >
): boolean {
  const graphEdgeIds = new Set(
    binding.graphRules?.flatMap((rule) => rule.edges.map((edge) => edge.id))
  );
  const graphStepIds = new Set(
    binding.graphRules?.flatMap((rule) => rule.transforms.map((step) => step.id))
  );
  // As in sliceOutputGraph, graph-owned projections are selected by their rule's final target.
  const targets: FieldRef[] = [
    ...(binding.storedProfileTargets ?? []),
    ...(binding.graphRules ?? []).map((rule) => rule.targetRef),
    ...(binding.edges ?? [])
      .filter((edge) => !graphEdgeIds.has(edge.id) && edge.targetRef.side === 'destination')
      .map((edge) => edge.targetRef),
    ...(binding.transforms ?? [])
      .filter((step) => !graphStepIds.has(step.id))
      .map((step) => step.outputTargetRef),
  ];
  return targets.some(
    (target) =>
      !isCanonicalInput(binding.catalog, target) &&
      target.namespace !== 'saml.attribute' &&
      target.namespace !== 'saml.nameid'
  );
}
