import { sameFieldRef } from './validation';
export { findSourceValue } from './source-values';
import { evaluateMappingRule, strongestMappingClassification } from './graph-evaluator';
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
  const values: SourceValueEnvelope[] = [];
  const reasons: ReasonCode[] = [];
  const ruleTrace: RuleTraceEntry[] = [];
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
