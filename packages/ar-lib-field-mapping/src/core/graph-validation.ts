import { analyzeMappingDependencies, identifierGraphProblem } from './graph';
import { persistentIdentifierSettingsProblem, validateTransformStep } from './transforms';
import { reason } from './reason-registry';
import type { MappingRuleGraph, ReasonCode } from './types';

export function validateMappingRuleGraph(rule: MappingRuleGraph): ReasonCode[] {
  try {
    analyzeMappingDependencies({ ...rule, edgeCount: rule.edges.length });
  } catch {
    return [reason('transform.invalid_reference')];
  }
  if (identifierGraphProblem(rule))
    return [reason('transform.identifier_post_transform_not_allowed')];
  if (
    rule.transforms.some(
      (step) =>
        step.operation === 'persistent_identifier' &&
        persistentIdentifierSettingsProblem(step.parameters) !== null
    )
  ) {
    return [reason('transform.identifier_unavailable')];
  }
  return rule.transforms.flatMap(
    (step) =>
      validateTransformStep({
        ...step,
        inputNames: step.inputs.map((ref) => ref.name),
        inputEdgeIds: step.inputs.map((_, index) => String(index)),
        outputTargetRef: rule.targetRef,
      }).reasons
  );
}
