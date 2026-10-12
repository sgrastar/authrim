/**
 * The part of a Field Mapping Set a destination runs: the edges (and the transforms that make
 * their values) that release to the destination.
 *
 * One set holds the rules of both directions, as the Admin UI saves it: the rules that bring a
 * source profile's fields into the canonical ones (SCIM, CSV, ...) and the rules that release
 * canonical fields to a destination. A destination runs only its own side, so only that side is
 * read for values, executed and judged for release safety, and all three use this one cut: an
 * edge left out of the cut makes no value, and an edge in it is judged.
 */

import type { FieldRef } from '@authrim/ar-lib-field-mapping/contract';
import { sameFieldRef } from '@authrim/ar-lib-field-mapping/authoring';

/** A reference as far as telling its direction needs it. */
export interface OutputGraphTarget {
  namespace?: string;
  /** The destination profile an edge releases into, when the edge carries it. */
  profileId?: string;
}

/** Whether a Destination Profile is what a profile id refers to. */
export function isDestinationProfileReference(profileId: string | null | undefined): boolean {
  return Boolean(
    profileId &&
    (profileId.startsWith('destination-profile-') || profileId.startsWith('destination_profile_'))
  );
}

/**
 * Whether an edge with this target releases to a destination: it is into a Destination Profile,
 * or into the destination's own namespace (the SAML attributes, for the SAML IdP).
 */
export function isOutputGraphTarget(
  target: OutputGraphTarget,
  destinationNamespace?: string
): boolean {
  return (
    isDestinationProfileReference(target.profileId) ||
    (destinationNamespace !== undefined && target.namespace === destinationNamespace)
  );
}

/** A reference as far as telling two of them apart needs it. */
export interface ComparableFieldReference {
  side: FieldRef['side'];
  namespace: string;
  path: string;
  catalogEntryId?: string;
}

/**
 * The edges that release to the destination, and the transforms that make their values, with
 * the edges those transforms take as input (an input edge is part of the cut whatever it
 * targets, as it is needed to make the value), and the validation rules that apply to them.
 *
 * A validation rule names a field, not an edge, and finds its value the way the validator does
 * (`sameFieldRef` of the field mapping library: the same decision, not a copy of it). It is kept when the field is one the cut uses
 * (a source or a target of a kept edge), and dropped when it is a field only the dropped edges
 * use (a rule on the source profile's field would otherwise ask for a value the cut never
 * reads). A rule that names neither is kept: what cannot be told is left to apply.
 */
export function sliceOutputGraph<
  E extends {
    id: string;
    sourceRef: ComparableFieldReference;
    targetRef: OutputGraphTarget & ComparableFieldReference;
  },
  T extends { inputEdgeIds: readonly string[]; outputTargetRef: OutputGraphTarget },
  V extends { targetRef: ComparableFieldReference } = never,
>(input: {
  edges: readonly E[];
  transforms: readonly T[];
  validationRules?: readonly V[];
  destinationNamespace: string;
}): { edges: E[]; transforms: T[]; validationRules: V[] } {
  const transforms = input.transforms.filter((transform) =>
    isOutputGraphTarget(transform.outputTargetRef, input.destinationNamespace)
  );
  const needed = new Set<string>(transforms.flatMap((transform) => transform.inputEdgeIds));
  const kept: E[] = [];
  const dropped: E[] = [];
  for (const edge of input.edges) {
    if (isOutputGraphTarget(edge.targetRef, input.destinationNamespace) || needed.has(edge.id)) {
      kept.push(edge);
    } else {
      dropped.push(edge);
    }
  }
  const usedBy = (edges: readonly E[], field: ComparableFieldReference) =>
    edges.some(
      (edge) => sameFieldRef(field, edge.sourceRef) || sameFieldRef(field, edge.targetRef)
    );
  const validationRules = (input.validationRules ?? []).filter(
    (rule) => usedBy(kept, rule.targetRef) || !usedBy(dropped, rule.targetRef)
  );
  return { edges: kept, transforms, validationRules };
}
