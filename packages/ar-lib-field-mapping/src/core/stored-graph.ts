import type { MappingValueReference } from './types';

export interface StoredMappingReference {
  edge_id: string | null;
  input_step_id: string | null;
  name?: string | null;
}

/** Decode rule-owned IDs, refusing dangling, cross-rule and forward references. */
export function readMappingReference(
  ref: StoredMappingReference,
  edgeIds: readonly string[],
  stepIds: readonly string[],
  before = stepIds.length
): MappingValueReference {
  if ((ref.edge_id === null) === (ref.input_step_id === null)) {
    throw new Error('invalid_reference: exactly one edge or step is required');
  }
  const name = ref.name === null || ref.name === undefined ? {} : { name: ref.name };
  const value: MappingValueReference =
    ref.edge_id !== null
      ? { edgeIndex: edgeIds.indexOf(ref.edge_id), ...name }
      : { stepIndex: stepIds.indexOf(ref.input_step_id ?? ''), ...name };
  if ('edgeIndex' in value && value.edgeIndex < 0)
    throw new Error('invalid_reference: dangling or cross-rule edge');
  if (
    'stepIndex' in value &&
    (!Number.isInteger(value.stepIndex) || value.stepIndex < 0 || value.stepIndex >= before)
  ) {
    throw new Error('invalid_reference: dangling, cross-rule or forward step');
  }
  if (value.name !== undefined && !value.name.trim())
    throw new Error('invalid_reference: empty input name');
  return value;
}
