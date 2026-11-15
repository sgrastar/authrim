/**
 * W1a persistence seam: tables still store one edge_id per step and no output reference.
 * TODO(W1b): store ordered inputs and explicit outputs, then remove representability checks.
 * Existing conflict policies rely on several legacy rules writing a target. They remain readable;
 * new graph requests reject duplicate targets. No schema or stored JSON format changes here.
 */
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
  return step.inputs ?? (step.edgeIndex === undefined ? [] : [{ edgeIndex: step.edgeIndex }]);
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
  const graphRequest =
    rule.output !== undefined || transforms.some((step) => step.inputs !== undefined);
  const refuse = (reason: string, message: string): never => {
    throw new MappingGraphContractError(reason, `${path}: ${message}`);
  };
  const steps = transforms.map((step) => {
    if (step.inputs !== undefined && !Array.isArray(step.inputs))
      refuse('invalid_reference', 'inputs must be an array');
    const inputs = transformInputs(step);
    if (inputs.some((ref) => ref === null || typeof ref !== 'object'))
      refuse('invalid_reference', 'inputs must contain references');
    if (
      step.inputs !== undefined &&
      step.edgeIndex !== undefined &&
      (inputs.length !== 1 || !('edgeIndex' in inputs[0]) || inputs[0].edgeIndex !== step.edgeIndex)
    ) {
      refuse('invalid_reference', 'edgeIndex disagrees with inputs');
    }
    return { inputs };
  });
  if (
    rule.output !== undefined &&
    (rule.output === null || typeof rule.output !== 'object' || Array.isArray(rule.output))
  ) {
    refuse('invalid_reference', 'output must be a reference');
  }
  if (transforms.some((step) => step.inputs !== undefined) && rule.output === undefined) {
    refuse('invalid_reference', 'the inputs shape requires an explicit output');
  }
  const output = ruleOutput(rule);
  if (graphRequest && !output) refuse('invalid_reference', 'output is required');
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
  if (!graphRequest) return;
  // Current rows can reconstruct only a single target, direct edge inputs, and last-step output.
  // Named inputs also need W1b: silently dropping their names would change the contract.
  const expected = transforms.length ? { stepIndex: transforms.length - 1 } : { edgeIndex: 0 };
  if (
    edges.length > 1 ||
    steps.some(
      (step) =>
        step.inputs.length > 1 ||
        step.inputs.some((ref) => 'stepIndex' in ref || ref.name !== undefined)
    ) ||
    JSON.stringify(output) !== JSON.stringify(expected)
  ) {
    refuse(
      'unsupported_until_w1b',
      'multi-input, chaining, named inputs and non-last output require W1b'
    );
  }
  const target = rule.targetRef ?? transforms.at(-1)?.targetRef ?? edges[0]?.targetRef;
  if (!target) refuse('invalid_reference', 'a rule needs one output target');
  const key = (ref: Record<string, unknown> | undefined) =>
    JSON.stringify([
      ref?.side ?? 'source',
      ref?.namespace,
      ref?.catalogEntryId,
      ref?.path ?? ref?.fieldKey ?? ref?.nodeId,
      ref?.profileId,
    ]);
  if (
    edges.some((edge) => key(edge.targetRef) !== key(target)) ||
    transforms.some((step) => step.targetRef && key(step.targetRef) !== key(target))
  ) {
    refuse('unsupported_until_w1b', 'multiple output targets require W1b');
  }
}

/** Translate only at the SQL boundary; never drop an unsupported input or output. */
export function persistentEdgeIndex(
  step: NonNullable<FieldMappingVersionRuleInput['transforms']>[number]
): number | undefined {
  const [input] = transformInputs(step);
  return input && 'edgeIndex' in input ? input.edgeIndex : undefined;
}

/** Legacy multi-target groups cannot truthfully advertise one graph output before W1b. */
export function canRepresentStoredRuleGraph(rule: {
  edges?: ReadonlyArray<{ targetRef: Record<string, unknown> }>;
  transforms?: ReadonlyArray<{ targetRef?: Record<string, unknown> | null }>;
}): boolean {
  if ((rule.edges?.length ?? 0) > 1) return false;
  const targets = [
    ...(rule.edges ?? []).map((edge) => edge.targetRef),
    ...(rule.transforms ?? []).flatMap((step) => (step.targetRef ? [step.targetRef] : [])),
  ];
  const key = (ref: Record<string, unknown>) =>
    JSON.stringify([
      ref.side ?? 'source',
      ref.namespace,
      ref.path ?? ref.fieldKey ?? ref.nodeId,
      ref.catalogEntryId,
      ref.profileId,
    ]);
  return targets.length > 0 && targets.every((target) => key(target) === key(targets[0]));
}

/** Account for the new GET shape when checking request budgets, including legacy writes. */
export function canonicalMappingRule(
  rule: FieldMappingVersionRuleInput
): FieldMappingVersionRuleInput {
  if (!canRepresentStoredRuleGraph(rule) || !ruleOutput(rule)) return rule;
  return {
    ...rule,
    output: ruleOutput(rule),
    ...(rule.transforms
      ? {
          transforms: rule.transforms.map((step) => {
            const { edgeIndex, ...rest } = step;
            return {
              ...rest,
              inputs: step.inputs ?? (edgeIndex === undefined ? [] : [{ edgeIndex }]),
            };
          }),
        }
      : {}),
  };
}
