import { partitionStoredMappingGraph } from './stored-graph';
import { sameFieldRef } from './validation';
import { findSourceValue } from './source-values';
export { findSourceValue } from './source-values';
import { evaluateMappingRule, strongestMappingClassification } from './graph-evaluator';
import { findCatalogEntry } from './catalog';
import { reason } from './reason-registry';
import { statusFromReasons } from './result';
import { buildTraceEntry } from './trace';
import { dropSuppressedTargets, executeTransformStep, sharesConsumedInput } from './transforms';

// What the hot path needs about persistent identifiers, through the runtime entrypoint.
export {
  PERSISTENT_IDENTIFIER_ALGORITHMS,
  PERSISTENT_IDENTIFIER_FORMATS,
  persistentIdentifierSettingsProblem,
} from './transforms';
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

/** OIDC and canonical projections assign each target in writer order: the last assignment wins. */
export function lastWriterMappingValues(values: SourceValueEnvelope[]): SourceValueEnvelope[] {
  const final = new Map<string, SourceValueEnvelope>();
  for (const value of values) {
    const ref = value.sourceRef;
    final.set(JSON.stringify([ref.side, ref.namespace, ref.path]), value);
  }
  return [...final.values()];
}

export function executeRuntimeMapping(input: MappingInput): RuntimeMappingResult {
  if (input.graphRules) return executeGraphMapping({ ...input, edges: [], transforms: [] });
  const partition = partitionStoredMappingGraph(input.edges, input.transforms ?? []);
  if (partition.graphRules.length) return executeGraphMapping({ ...input, ...partition }, input);
  return executeLegacyMapping(input);
}

/** TODO(W1b): remove flattened raw-edge/last-value compatibility after graph migration. */
function executeLegacyMapping(
  input: MappingInput,
  onValue?: (
    value: SourceValueEnvelope,
    writer: { edgeId: string } | { transformId: string }
  ) => void
): RuntimeMappingResult {
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
    onValue?.(targetValue, { edgeId: edge.id });
    mappingTrace.push(
      buildTraceEntry({
        reason: reason('trace.mapping_evaluated'),
        action: 'mapped',
        fieldRef: edge.targetRef,
        edgeId: edge.id,
      })
    );
  }

  const sharedInput = sharesConsumedInput(input.transforms, input.edges);
  if (sharedInput) {
    // What an identifier is made from would leave through the other step: nothing goes out.
    transformReasons.push(reason('transform.identifier_unavailable'));
  }
  for (const step of input.transforms ?? []) {
    const result = executeTransformStep({ step, edgeValues, runtimeContext: input.runtimeContext });
    transformReasons.push(...result.reasons);
    transformTrace.push(...result.trace);
    if (result.value) {
      mappedValues.push(result.value);
      onValue?.(result.value, { transformId: step.id });
    }
  }

  const remaining = dropSuppressedTargets(mappedValues, input.transforms, input.runtimeContext);

  const reasons = [...validation.reasons, ...transformReasons];
  return {
    status: statusFromReasons(reasons),
    reasons,
    ruleTrace: [...validation.trace, ...mappingTrace, ...transformTrace],
    values: sharedInput
      ? []
      : remaining.filter((value) => findCatalogEntry(input.catalog, value.sourceRef)),
  };
}

function executeGraphMapping(
  input: MappingInput,
  storedOrder?: Pick<MappingInput, 'edges' | 'transforms'>
): RuntimeMappingResult {
  const edgeOrder = new Map(storedOrder?.edges.map((edge, index) => [edge.id, index]));
  const transformOrder = new Map(
    storedOrder?.transforms?.map((step, index) => [
      step.id,
      (storedOrder?.edges.length ?? 0) + index,
    ])
  );
  const positions = new Map<SourceValueEnvelope, number>();
  const remember = (
    value: SourceValueEnvelope,
    writer: { edgeId: string } | { transformId: string }
  ) => {
    const position =
      'edgeId' in writer ? edgeOrder.get(writer.edgeId) : transformOrder.get(writer.transformId);
    if (position !== undefined) positions.set(value, position);
  };
  const legacy = executeLegacyMapping(
    { ...input, graphRules: undefined, validationRules: [] },
    remember
  );
  const values: SourceValueEnvelope[] = [...legacy.values];
  const reasons: ReasonCode[] = [...legacy.reasons];
  const ruleTrace: RuleTraceEntry[] = [...legacy.ruleTrace];
  const targets = new Set<string>();
  for (const rule of input.graphRules ?? []) {
    const target = JSON.stringify([
      rule.targetRef.side,
      rule.targetRef.namespace,
      rule.targetRef.path,
    ]);
    if (targets.has(target) && !storedOrder) {
      reasons.push(reason('transform.duplicate_target'));
      return { status: 'failed', values: [], reasons, ruleTrace };
    }
    targets.add(target);
    if (
      !findCatalogEntry(input.catalog, rule.targetRef) ||
      rule.edges.some((edge) => !findCatalogEntry(input.catalog, edge.sourceRef))
    ) {
      reasons.push(reason('catalog.invalid_entry'));
      continue;
    }
    const result = evaluateMappingRule({
      rule,
      sourceValues: input.sourceValues.map((value) => ({
        ...value,
        classificationHint: strongestMappingClassification(
          value.classificationHint,
          findCatalogEntry(input.catalog, value.sourceRef)?.classification
        ),
      })),
      runtimeContext: input.runtimeContext,
      preparedSteps: input.preparedSteps,
      edgeValueReferences: storedOrder ? 'target' : 'source',
    });
    reasons.push(...result.reasons);
    ruleTrace.push(...result.trace);
    if (result.output.kind === 'value') {
      values.push(result.output.envelope);
      remember(
        result.output.envelope,
        'edgeIndex' in rule.output
          ? { edgeId: rule.edges[rule.output.edgeIndex].id }
          : { transformId: rule.transforms[rule.output.stepIndex].id }
      );
    }
  }
  // A stored graph replaces its edge/step writers with one writer at its declared output.
  // Keep the original row order across graph and legacy rules; conflict consumers see only finals.
  if (storedOrder) values.sort((a, b) => (positions.get(a) ?? 0) - (positions.get(b) ?? 0));
  const released = dropSuppressedTargets(
    values,
    input.transforms,
    input.runtimeContext,
    input.graphRules
  ).filter((value) => findCatalogEntry(input.catalog, value.sourceRef));
  const finalValues = (input.resolveValidationValues ?? lastWriterMappingValues)(released);
  const outputTargets = [
    ...input.edges.map((edge) => edge.targetRef),
    ...(input.transforms ?? []).map((step) => step.outputTargetRef),
    ...(input.graphRules ?? []).map((rule) => rule.targetRef),
  ];
  // Required/type/cardinality are judged on released values, never on raw/intermediate values.
  // Suppression precedes resolution, and original target values cannot stand in for absent outputs.
  const validation = validateMappingInput({
    ...input,
    graphRules: undefined,
    edges: [],
    transforms: [],
    sourceValues: [
      ...input.sourceValues.filter(
        (source) => !outputTargets.some((target) => sameFieldRef(source.sourceRef, target))
      ),
      ...finalValues,
    ],
  });
  reasons.push(...validation.reasons);
  ruleTrace.push(...validation.trace);
  return {
    status: statusFromReasons(reasons),
    values: released,
    reasons,
    ruleTrace,
  };
}
