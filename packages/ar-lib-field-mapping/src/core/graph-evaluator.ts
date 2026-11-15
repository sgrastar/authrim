import { buildTraceEntry } from './trace';
import { reason } from './reason-registry';
/**
 * Evaluation is synchronous. Async operations use a caller-owned pre-pass, like identifiers:
 * await preparation once, then pass per-step results in preparedSteps. No promises or secrets
 * enter an operation. W2 can prepare keyed hashes through this hook without changing callers.
 */
import { analyzeMappingDependencies } from './graph';
import { validateMappingRuleGraph } from './graph-validation';
import { executeTransformStep } from './transforms';
import { findSourceValue } from './source-values';
import type {
  MappingRuleGraph,
  MappingEvaluationValue,
  MappingValueReference,
  SourceValueEnvelope,
  ReasonCode,
  RuleTraceEntry,
  RedactionClassification,
} from './types';

export interface GraphEvaluationInput {
  rule: MappingRuleGraph;
  sourceValues: SourceValueEnvelope[];
  runtimeContext?: Record<string, unknown>;
  preparedSteps?: ReadonlyMap<string, MappingEvaluationValue>;
  /** Stored-row compatibility: json_build historically keys values by their edge target. */
  edgeValueReferences?: 'source' | 'target';
}

export function evaluateMappingRule(input: GraphEvaluationInput): {
  output: MappingEvaluationValue;
  steps: ReadonlyMap<number, MappingEvaluationValue>;
  reasons: ReasonCode[];
  trace: RuleTraceEntry[];
} {
  const { rule } = input;
  const steps = new Map<number, MappingEvaluationValue>();
  const reasons: ReasonCode[] = [];
  const trace: RuleTraceEntry[] = [];
  reasons.push(...validateMappingRuleGraph(rule));
  if (reasons.length) return { output: { kind: 'failed' }, steps, reasons, trace };
  const dependencies = analyzeMappingDependencies({ ...rule, edgeCount: rule.edges.length });
  const read = (ref: MappingValueReference): MappingEvaluationValue => {
    if ('stepIndex' in ref) return steps.get(ref.stepIndex) ?? { kind: 'failed' };
    const edge = rule.edges[ref.edgeIndex];
    const value = findSourceValue(input.sourceValues, edge);
    return value && value.value !== undefined
      ? {
          kind: 'value',
          envelope:
            input.edgeValueReferences === 'target'
              ? { ...value, sourceRef: edge.targetRef }
              : value,
        }
      : { kind: 'absent' };
  };
  for (const index of dependencies.edgeIndexes) {
    const edge = rule.edges[index];
    if (findSourceValue(input.sourceValues, edge))
      trace.push(
        buildTraceEntry({
          reason: reason('trace.mapping_evaluated'),
          action: 'mapped',
          fieldRef: rule.targetRef,
          edgeId: edge.id,
          ruleId: rule.id,
        })
      );
  }
  for (const index of dependencies.stepIndexes) {
    const step = rule.transforms[index];
    const values = step.inputs.map(read);
    if (values.some((value) => value.kind === 'suppressed')) {
      steps.set(index, { kind: 'suppressed' });
      continue;
    }
    if (values.some((value) => value.kind === 'failed')) {
      steps.set(index, { kind: 'failed' });
      continue;
    }
    const suppressed = input.runtimeContext?.suppressedIdentifiers;
    if (
      step.operation === 'persistent_identifier' &&
      typeof suppressed === 'object' &&
      suppressed !== null &&
      step.id in suppressed &&
      Reflect.get(suppressed, step.id) === true
    ) {
      steps.set(index, { kind: 'suppressed' });
      continue;
    }
    // Missing attributes are values, not broken references. Only combining operations consume
    // absence; other operations propagate it without fabricating null, text or a failure.
    if (
      values.some((value) => value.kind === 'absent') &&
      !['fallback', 'first', 'concat', 'join', 'json_build'].includes(step.operation)
    ) {
      steps.set(index, { kind: 'absent' });
      continue;
    }
    if (
      (step.operation === 'fallback' || step.operation === 'first') &&
      values.every((value) => value.kind === 'absent')
    ) {
      steps.set(index, { kind: 'absent' });
      continue;
    }
    const prepared = input.preparedSteps?.get(step.id);
    if (prepared) {
      steps.set(
        index,
        prepared.kind === 'value'
          ? {
              kind: 'value',
              envelope: {
                ...prepared.envelope,
                classificationHint: dependencyClassification([...values, prepared]),
              },
            }
          : prepared
      );
      continue;
    }
    const edgeValues = new Map<string, SourceValueEnvelope>();
    values.forEach((value, position) =>
      edgeValues.set(
        String(position),
        value.kind === 'value' ? value.envelope : { value: undefined, sourceRef: rule.targetRef }
      )
    );
    const result = executeTransformStep({
      step: { ...step, inputEdgeIds: [...edgeValues.keys()], outputTargetRef: rule.targetRef },
      edgeValues,
      runtimeContext: input.runtimeContext,
    });
    reasons.push(...result.reasons);
    trace.push(...result.trace);
    if (!result.value) {
      steps.set(index, { kind: 'failed' });
    } else if (result.value.value === undefined) {
      steps.set(index, { kind: 'absent' });
    } else {
      steps.set(index, {
        kind: 'value',
        envelope: {
          ...result.value,
          sourceRef:
            values.length === 1 && values[0].kind === 'value'
              ? values[0].envelope.sourceRef
              : result.value.sourceRef,
          classificationHint: dependencyClassification(values),
          provenanceHints: values.flatMap((value) =>
            value.kind === 'value'
              ? (value.envelope.provenanceHints ??
                (value.envelope.provenanceHint ? [value.envelope.provenanceHint] : []))
              : []
          ),
        },
      });
    }
  }
  const output = read(rule.output);
  return {
    output:
      output.kind === 'value'
        ? { kind: 'value', envelope: { ...output.envelope, sourceRef: rule.targetRef } }
        : output,
    steps,
    reasons,
    trace,
  };
}

const CLASSIFICATIONS: RedactionClassification[] = [
  'public',
  'internal',
  'pii',
  'regulated',
  'secret',
  'credential',
  'token',
  'key_material',
];
export function strongestMappingClassification(
  ...classifications: Array<RedactionClassification | undefined>
): RedactionClassification | undefined {
  let strongest: RedactionClassification | undefined;
  for (const classification of classifications) {
    if (
      classification &&
      (!strongest || CLASSIFICATIONS.indexOf(classification) > CLASSIFICATIONS.indexOf(strongest))
    )
      strongest = classification;
  }
  return strongest;
}

function dependencyClassification(
  values: MappingEvaluationValue[]
): RedactionClassification | undefined {
  return strongestMappingClassification(
    ...values.map((value) =>
      value.kind === 'value' ? value.envelope.classificationHint : undefined
    )
  );
}
