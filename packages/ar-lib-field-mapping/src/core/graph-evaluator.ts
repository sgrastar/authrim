import {
  TRANSFORM_LIMITS,
  chargeTransformInput,
  chargeTransformOutput,
  TransformFailure,
} from './transform-safety';
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
  MappingGraphTransform,
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
  /** Catalog classifications also apply to absent dependencies (presence can be sensitive). */
  sourceClassifications?: ReadonlyMap<number, RedactionClassification>;
  runtimeContext?: Record<string, unknown>;
  preparedSteps?: ReadonlyMap<string, MappingEvaluationValue>;
  /** Trusted synchronous preparers consume cached dependency results after input budget checks. */
  stepPreparers?: ReadonlyMap<
    string,
    (inputs: readonly MappingEvaluationValue[]) => MappingEvaluationValue
  >;
  /** Authoring traces may need disconnected steps too; all share the same rule work budget. */
  evaluateAllSteps?: boolean;
  /** Stored-row compatibility: json_build historically keys values by their edge target. */
  edgeValueReferences?: 'source' | 'target';
}

export interface MappingStepPreparation {
  step: MappingGraphTransform;
  inputs: readonly MappingEvaluationValue[];
}
export type MappingStepPreparer = (
  request: MappingStepPreparation
) => Promise<MappingEvaluationValue>;
export interface GraphEvaluationResult {
  output: MappingEvaluationValue;
  steps: ReadonlyMap<number, MappingEvaluationValue>;
  reasons: ReasonCode[];
  trace: RuleTraceEntry[];
}

export function evaluateMappingRule(input: GraphEvaluationInput): GraphEvaluationResult {
  const evaluation = evaluateRuleSteps(input, false);
  let next = evaluation.next();
  while (!next.done) next = evaluation.next({ kind: 'failed' });
  return next.value;
}

/** Resume the same evaluation after each asynchronous preparation: no dependency replay. */
export async function evaluatePreparedMappingRule(
  input: GraphEvaluationInput,
  prepare: MappingStepPreparer
): Promise<GraphEvaluationResult> {
  const evaluation = evaluateRuleSteps(input, true);
  let next = evaluation.next();
  while (!next.done) {
    let prepared: MappingEvaluationValue;
    try {
      prepared = await prepare(next.value);
    } catch {
      prepared = { kind: 'failed' };
    }
    next = evaluation.next(prepared);
  }
  return next.value;
}

function* evaluateRuleSteps(
  input: GraphEvaluationInput,
  prepareAsync: boolean
): Generator<MappingStepPreparation, GraphEvaluationResult, MappingEvaluationValue> {
  const { rule } = input;
  const steps = new Map<number, MappingEvaluationValue>();
  const stepClassifications = new Map<number, RedactionClassification | undefined>();
  const reasons: ReasonCode[] = [];
  const trace: RuleTraceEntry[] = [];
  reasons.push(...validateMappingRuleGraph(rule));
  if (reasons.length) return { output: { kind: 'failed' }, steps, reasons, trace };
  const dependencies = analyzeMappingDependencies({ ...rule, edgeCount: rule.edges.length });
  if (input.evaluateAllSteps) {
    // Preserve runtime output semantics: spend its dependency budget first, then use the
    // remaining budget for disconnected trace rows. Backwards references make index order
    // topological for those remaining steps, and cached output dependencies are never replayed.
    const selected = new Set(dependencies.stepIndexes);
    rule.transforms.forEach((_, index) => {
      if (!selected.has(index)) dependencies.stepIndexes.push(index);
    });
    rule.edges.forEach((_, index) => dependencies.edgeIndexes.add(index));
  }
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
  const workBudget = { remaining: TRANSFORM_LIMITS.ruleWork };
  for (const index of dependencies.stepIndexes) {
    const step = rule.transforms[index];
    const values = step.inputs.map(read);
    const classification = strongestMappingClassification(
      dependencyClassification(values),
      ...step.inputs.map((ref) =>
        'edgeIndex' in ref
          ? input.sourceClassifications?.get(ref.edgeIndex)
          : stepClassifications.get(ref.stepIndex)
      )
    );
    stepClassifications.set(index, classification);
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
    // Unknown consent dependencies cannot drive conditions, conversions, deletion or another hash.
    // Keep the output pending even if a branch might later omit it; failure/suppression win above.
    if (values.some((value) => value.kind === 'deferred')) {
      steps.set(index, { kind: 'deferred' });
      continue;
    }
    // Missing attributes are values, not broken references. Only combining operations consume
    // absence, as do default_if_empty and has_value; other operations propagate it.
    if (
      values.some((value) => value.kind === 'absent') &&
      ![
        'fallback',
        'first',
        'concat',
        'join',
        'json_build',
        'array_build',
        'conditional',
        'json_extract_or',
        'default_if_empty',
        'has_value',
      ].includes(step.operation)
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
    const preparation = input.preparedSteps?.get(step.id) ?? input.stepPreparers?.get(step.id);
    if (preparation || (step.operation === 'hash' && prepareAsync)) {
      let prepared: MappingEvaluationValue;
      try {
        chargeTransformInput(
          {
            ...step,
            inputNames: step.inputs.map((ref) => ref.name),
            inputEdgeIds: step.inputs.map((_, i) => String(i)),
            outputTargetRef: rule.targetRef,
          },
          values.map((value) => (value.kind === 'value' ? value.envelope.value : undefined)),
          workBudget,
          values.flatMap((value) => (value.kind === 'value' ? [value.envelope] : []))
        );
        prepared = preparation
          ? typeof preparation === 'function'
            ? preparation(values)
            : preparation
          : yield { step, inputs: values };
        if (prepared.kind === 'failed' && step.operation === 'hash') {
          reasons.push(reason('transform.hash_unavailable'));
          trace.push(
            buildTraceEntry({
              reason: reason('transform.hash_unavailable'),
              transformStepId: step.id,
            })
          );
        }
        if (prepared.kind === 'value') chargeTransformOutput(prepared.envelope.value, workBudget);
      } catch (error) {
        const issue = reason(
          error instanceof TransformFailure ? error.code : 'transform.invalid_output'
        );
        reasons.push(issue);
        trace.push(buildTraceEntry({ reason: issue, transformStepId: step.id }));
        steps.set(index, { kind: 'failed' });
        continue;
      }
      steps.set(
        index,
        prepared.kind === 'value'
          ? {
              kind: 'value',
              envelope: {
                ...prepared.envelope,
                classificationHint: strongestMappingClassification(
                  classification,
                  prepared.envelope.classificationHint
                ),
                provenanceHints: values.flatMap((value) =>
                  value.kind === 'value'
                    ? (value.envelope.provenanceHints ??
                      (value.envelope.provenanceHint ? [value.envelope.provenanceHint] : []))
                    : []
                ),
              },
            }
          : prepared
      );
      if (prepared.kind !== 'failed')
        trace.push(
          buildTraceEntry({
            reason: reason('trace.transform_evaluated'),
            action: 'transformed',
            transformStepId: step.id,
            fieldRef: rule.targetRef,
          })
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
      step: {
        ...step,
        inputNames: step.inputs.map((ref) => ref.name),
        inputEdgeIds: [...edgeValues.keys()],
        outputTargetRef: rule.targetRef,
      },
      edgeValues,
      runtimeContext: input.runtimeContext,
      workBudget,
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
          classificationHint: classification,
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
