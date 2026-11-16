import {
  analyzeMappingDependencies,
  IDENTIFIER_POST_TRANSFORM_OPERATIONS,
  TRANSFORM_OPERATION_SCHEMAS,
  validateTransformStep,
} from '@authrim/ar-lib-field-mapping/authoring';
import type { MappingValueReference } from '@authrim/ar-lib-field-mapping/contract';
import type { FieldMappingVersionRuleInput } from './identity-mapping-control-plane';

export class MappingGraphContractError extends Error {
  constructor(
    readonly reason: string,
    message: string
  ) {
    super(message);
  }
}

export function transformInputs(
  step: NonNullable<FieldMappingVersionRuleInput['transforms']>[number]
): MappingValueReference[] {
  return step.inputs ?? [];
}

export function ruleOutput(rule: FieldMappingVersionRuleInput): MappingValueReference | undefined {
  return (
    rule.output ??
    ((rule.transforms?.length ?? 0) > 0
      ? { stepIndex: (rule.transforms?.length ?? 0) - 1 }
      : rule.edges?.length === 1
        ? { edgeIndex: 0 }
        : undefined)
  );
}

export function assertMappingGraphContract(rule: FieldMappingVersionRuleInput, path: string): void {
  const transforms = rule.transforms ?? [];
  const edges = rule.edges ?? [];
  const graphRequest = edges.length > 0 || transforms.length > 0;
  const refuse = (reason: string, message: string): never => {
    throw new MappingGraphContractError(reason, `${path}: ${message}`);
  };
  const steps = transforms.map((step) => {
    if (step.inputs !== undefined && !Array.isArray(step.inputs))
      refuse('invalid_reference', 'inputs must be an array');
    const inputs = transformInputs(step);
    if (inputs.some((ref) => ref === null || typeof ref !== 'object'))
      refuse('invalid_reference', 'inputs must contain references');
    if ('edgeIndex' in step) refuse('invalid_reference', 'use inputs instead of legacy edgeIndex');
    return { inputs };
  });
  if (
    rule.output !== undefined &&
    (rule.output === null || typeof rule.output !== 'object' || Array.isArray(rule.output))
  ) {
    refuse('invalid_reference', 'output must be a reference');
  }
  const output = ruleOutput(rule);
  if (graphRequest && !output) refuse('invalid_reference', 'output is required');
  if (output?.name !== undefined) refuse('invalid_reference', 'names apply only to step inputs');
  if (output) {
    try {
      analyzeMappingDependencies({ edgeCount: edges.length, transforms: steps, output });
    } catch {
      refuse('invalid_reference', 'dangling, forward or cyclic reference');
    }
  }
  // Validate all operations for both platform and tenant versions, including legacy requests.
  for (const [index, step] of transforms.entries()) {
    if (
      step.parameters !== undefined &&
      (step.parameters === null ||
        typeof step.parameters !== 'object' ||
        Array.isArray(step.parameters))
    ) {
      refuse('invalid_transform', `transforms[${index}].parameters must be an object`);
    }
    const schema = TRANSFORM_OPERATION_SCHEMAS.find((item) => item.operation === step.operation);
    if (!schema) refuse('invalid_transform', `transforms[${index}].operation is not supported`);
    if (schema) {
      const checked = validateTransformStep({
        id: `${path}.transforms[${index}]`,
        operation: schema.operation,
        inputEdgeIds: steps[index].inputs.map((_, i) => String(i)),
        parameters: step.parameters,
        inputNames: steps[index].inputs.map((ref) => ref.name),
        outputTargetRef: { side: 'destination', namespace: 'check', path: 'check' },
      });
      if (checked.reasons.length)
        refuse('invalid_transform', `transforms[${index}].parameters or input arity are not valid`);
    }
  }
  const tainted: boolean[] = [];
  for (const [index, step] of transforms.entries()) {
    const follows = steps[index].inputs.some((ref) => 'stepIndex' in ref && tainted[ref.stepIndex]);
    const target = rule.targetRef ?? step.targetRef ?? edges[0]?.targetRef;
    if (
      follows &&
      (!IDENTIFIER_POST_TRANSFORM_OPERATIONS.includes(step.operation) ||
        target?.namespace === 'saml.nameid')
    ) {
      refuse('identifier_post_transform_not_allowed', 'identifier post-transform is not allowed');
    }
    tainted[index] = follows || step.operation === 'persistent_identifier';
  }
  const target = rule.targetRef ?? edges[0]?.targetRef ?? transforms.at(-1)?.targetRef;
  if ((edges.length || transforms.length) && !target)
    refuse('invalid_reference', 'a rule needs one output target');
}

export function canonicalMappingRule(
  rule: FieldMappingVersionRuleInput
): FieldMappingVersionRuleInput {
  const targetRef = ruleTarget(rule);
  return {
    ...rule,
    ...(ruleOutput(rule) ? { output: ruleOutput(rule) } : {}),
    ...(targetRef ? { targetRef: structuredClone(targetRef) } : {}),
    ...(rule.transforms
      ? {
          transforms: rule.transforms.map(({ targetRef: _targetRef, ...step }) => ({
            ...step,
            inputs: transformInputs(step),
          })),
        }
      : {}),
  };
}

export function ruleTarget(
  rule: FieldMappingVersionRuleInput
): Record<string, unknown> | undefined {
  return rule.targetRef ?? rule.edges?.[0]?.targetRef ?? rule.transforms?.at(-1)?.targetRef;
}
