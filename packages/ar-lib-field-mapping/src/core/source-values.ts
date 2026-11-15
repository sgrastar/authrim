import type { MappingInput, SourceValueEnvelope } from './types';

/** The source value an edge reads: by catalog entry where both name one, else by place. */
export function findSourceValue(
  sourceValues: SourceValueEnvelope[],
  edge: MappingInput['edges'][number]
): SourceValueEnvelope | undefined {
  return sourceValues.find((value) => {
    if (value.sourceRef.catalogEntryId && edge.sourceRef.catalogEntryId) {
      return value.sourceRef.catalogEntryId === edge.sourceRef.catalogEntryId;
    }
    return (
      value.sourceRef.side === edge.sourceRef.side &&
      value.sourceRef.namespace === edge.sourceRef.namespace &&
      value.sourceRef.path === edge.sourceRef.path
    );
  });
}
