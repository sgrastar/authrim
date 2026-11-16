import { sameFieldRef } from './validation';
export { findSourceValue } from './source-values';
import {
  evaluatePreparedMappingRule,
  type GraphEvaluationResult,
  type MappingStepPreparer,
  evaluateMappingRule,
  strongestMappingClassification,
} from './graph-evaluator';
import { findCatalogEntry } from './catalog';
import { reason } from './reason-registry';
import { statusFromReasons } from './result';
import { dropSuppressedTargets } from './transforms';

// What the hot path needs about persistent identifiers, through the runtime entrypoint.
export {
  PERSISTENT_IDENTIFIER_ALGORITHMS,
  PERSISTENT_IDENTIFIER_FORMATS,
  persistentIdentifierSettingsProblem,
} from './transforms';
import { validateMappingInput } from './validation';
import type {
  MappingInput,
  MappingRuleGraph,
  RedactionClassification,
  MappingResultStatus,
  ReasonCode,
  RuleTraceEntry,
  SourceValueEnvelope,
  FieldRef,
} from './types';

export interface RuntimeMappingResult {
  status: MappingResultStatus;
  reasons: ReasonCode[];
  ruleTrace: RuleTraceEntry[];
  values: SourceValueEnvelope[];
  /** Consent item identities only; never substitute values for these targets. */
  deferredTargets?: FieldRef[];
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

/** Async preparation uses the synchronous evaluator's continuation and shared work budget. */
export async function executePreparedRuntimeMapping(
  input: MappingInput,
  prepare: MappingStepPreparer
): Promise<RuntimeMappingResult> {
  const evaluated = new Map<
    NonNullable<MappingInput['graphRules']>[number],
    GraphEvaluationResult
  >();
  for (const rule of input.graphRules ?? []) {
    evaluated.set(
      rule,
      await evaluatePreparedMappingRule(
        {
          rule,
          sourceValues: classifiedSources(input),
          sourceClassifications: sourceClassifications(input, rule),
          runtimeContext: input.runtimeContext,
          preparedSteps: input.preparedSteps,
          edgeValueReferences: rule.edgeValueReferences,
        },
        prepare
      )
    );
  }
  return executeRuntimeMappingResults(input, evaluated);
}

function sourceClassifications(
  input: MappingInput,
  rule: MappingRuleGraph
): ReadonlyMap<number, RedactionClassification> {
  const classifications = new Map<number, RedactionClassification>();
  rule.edges.forEach((edge, index) => {
    const classification = findCatalogEntry(input.catalog, edge.sourceRef)?.classification;
    if (classification) classifications.set(index, classification);
  });
  return classifications;
}

function classifiedSources(input: MappingInput): SourceValueEnvelope[] {
  return input.sourceValues.map((value) => ({
    ...value,
    classificationHint: strongestMappingClassification(
      value.classificationHint,
      findCatalogEntry(input.catalog, value.sourceRef)?.classification
    ),
  }));
}

export function executeRuntimeMapping(input: MappingInput): RuntimeMappingResult {
  return executeRuntimeMappingResults(input);
}

function executeRuntimeMappingResults(
  input: MappingInput,
  evaluated?: ReadonlyMap<NonNullable<MappingInput['graphRules']>[number], GraphEvaluationResult>
): RuntimeMappingResult {
  const values: SourceValueEnvelope[] = [];
  const reasons: ReasonCode[] = [];
  const ruleTrace: RuleTraceEntry[] = [];
  const deferredTargets: FieldRef[] = [];
  if (!input.graphRules && (input.edges.length || input.transforms?.length)) {
    return {
      status: 'failed',
      values,
      reasons: [reason('transform.invalid_reference')],
      ruleTrace,
    };
  }
  const identifierRules = (input.graphRules ?? []).filter((rule) =>
    rule.transforms.some((step) => step.operation === 'persistent_identifier')
  );
  if (
    identifierRules.some(
      (rule) =>
        rule.transforms.some(
          (step) => step.operation === 'persistent_identifier' && step.inputs.length > 0
        ) ||
        input.graphRules?.some(
          (other) => other !== rule && sameFieldRef(other.targetRef, rule.targetRef)
        )
    )
  ) {
    return {
      status: 'failed',
      values: [],
      reasons: [reason('transform.identifier_unavailable')],
      ruleTrace,
    };
  }
  const targets = new Set<string>();
  for (const rule of input.graphRules ?? []) {
    const target = JSON.stringify([
      rule.targetRef.side,
      rule.targetRef.namespace,
      rule.targetRef.path,
    ]);
    if (targets.has(target) && rule.writerOrder === undefined) {
      reasons.push(reason('transform.duplicate_target'));
      return { status: 'failed', values: [], reasons, ruleTrace };
    }
    targets.add(target);
    const result =
      evaluated?.get(rule) ??
      evaluateMappingRule({
        rule,
        sourceValues: classifiedSources(input),
        sourceClassifications: sourceClassifications(input, rule),
        runtimeContext: input.runtimeContext,
        preparedSteps: input.preparedSteps,
        edgeValueReferences: rule.edgeValueReferences,
      });
    reasons.push(...result.reasons);
    ruleTrace.push(...result.trace);
    if (
      !findCatalogEntry(input.catalog, rule.targetRef) ||
      (input.sourceCatalogValidation !== 'receiver' &&
        rule.edges.some((edge) => !findCatalogEntry(input.catalog, edge.sourceRef)))
    ) {
      reasons.push(reason('catalog.invalid_entry'));
      continue;
    }
    if (result.output.kind === 'value') {
      values.push(result.output.envelope);
    } else if (result.output.kind === 'deferred') {
      deferredTargets.push(rule.targetRef);
      if (!input.allowDeferredOutputs) reasons.push(reason('transform.deferred_output'));
    }
  }
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
    validationRules: input.validationRules?.filter(
      (rule) => !deferredTargets.some((target) => sameFieldRef(target, rule.targetRef))
    ),
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
    ...(deferredTargets.length > 0 ? { deferredTargets } : {}),
  };
}

export type { MappingStepPreparer, MappingStepPreparation } from './graph-evaluator';
