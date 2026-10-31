import type { FieldRef } from '@authrim/ar-lib-field-mapping/contract';
import { sliceOutputGraph } from './identity-mapping-output-graph';

/**
 * What a SAML service provider's saved Mapping Set choice must keep true of the Destination
 * Profile it releases into. Shared by the check that saves a provider's configuration (ar-saml) and
 * by the check that puts another version of the Mapping Set in use (ar-management), so the two
 * cannot disagree.
 */

/**
 * Whether the per-field release policies a provider saved name exactly the fields of the profile
 * (and the profile has some): a policy for each field, none for a field it does not have.
 */
export function samlDestinationPolicyCoversProfile(
  policyKeys: Iterable<string>,
  profileFieldKeys: Iterable<string>
): boolean {
  const profileFields = new Set(profileFieldKeys);
  const policyFields = new Set(policyKeys);
  return (
    profileFields.size > 0 &&
    profileFields.size === policyFields.size &&
    [...profileFields].every((field) => policyFields.has(field))
  );
}

/**
 * The attributes a mapping releases to the SAML destination whose descriptor names them otherwise
 * than the field: the outputs of the destination's cut of the mapping (as the runtime reads the
 * references, in whatever spelling they were written), judged by `findRenamedAttributeDescriptors`.
 * The check that saves a provider's configuration and the one that puts another version in use
 * both ask this.
 */
export function findRenamedOutputAttributes(
  graph: {
    edges: ReadonlyArray<{ id: string; sourceRef: FieldRef; targetRef: FieldRef }>;
    transforms: ReadonlyArray<{ inputEdgeIds: readonly string[]; outputTargetRef: FieldRef }>;
  },
  destinationNamespace: string,
  descriptors: Record<string, { name?: string; friendlyName?: string }> | undefined
): string[] {
  const outputGraph = sliceOutputGraph({
    edges: graph.edges,
    transforms: graph.transforms,
    destinationNamespace,
  });
  return findRenamedAttributeDescriptors(
    [
      ...outputGraph.edges.map((edge) => edge.targetRef),
      ...outputGraph.transforms.map((transform) => transform.outputTargetRef),
    ],
    descriptors
  );
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
