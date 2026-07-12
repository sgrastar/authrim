import { findCatalogEntry } from './catalog';
import { reason } from './reason-registry';
import { statusFromReasons } from './result';
import { buildTraceEntry } from './trace';
import { executeTransformStep } from './transforms';
import { validateMappingInput } from './validation';
import type {
  MappingInput,
  MappingResultStatus,
  ReasonCode,
  RuleTraceEntry,
  SourceValueEnvelope,
} from './types';

export interface RuntimeMappingResult {
  status: MappingResultStatus;
  reasons: ReasonCode[];
  ruleTrace: RuleTraceEntry[];
  values: SourceValueEnvelope[];
}

export function executeRuntimeMapping(input: MappingInput): RuntimeMappingResult {
  const validation = validateMappingInput(input);
  const edgeValues = new Map<string, SourceValueEnvelope>();
  const mappedValues: SourceValueEnvelope[] = [];
  const transformReasons: ReasonCode[] = [];
  const transformTrace: RuleTraceEntry[] = [];
  const mappingTrace: RuleTraceEntry[] = [];

  for (const edge of input.edges) {
    const sourceValue = findSourceValue(input.sourceValues, edge);
    if (!sourceValue) {
      continue;
    }
    const targetValue: SourceValueEnvelope = {
      ...sourceValue,
      sourceRef: edge.targetRef,
    };
    edgeValues.set(edge.id, targetValue);
    mappedValues.push(targetValue);
    mappingTrace.push(
      buildTraceEntry({
        reason: reason('trace.mapping_evaluated'),
        action: 'mapped',
        fieldRef: edge.targetRef,
        edgeId: edge.id,
      })
    );
  }

  for (const step of input.transforms ?? []) {
    const result = executeTransformStep({ step, edgeValues, runtimeContext: input.runtimeContext });
    transformReasons.push(...result.reasons);
    transformTrace.push(...result.trace);
    if (result.value) {
      mappedValues.push(result.value);
    }
  }

  const reasons = [...validation.reasons, ...transformReasons];
  return {
    status: statusFromReasons(reasons),
    reasons,
    ruleTrace: [...validation.trace, ...mappingTrace, ...transformTrace],
    values: mappedValues.filter((value) => findCatalogEntry(input.catalog, value.sourceRef)),
  };
}

function findSourceValue(
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
