import type { MappingValueReference, MappingRuleGraph } from './types';

/** Only these text operations may depend on a persistent identifier. */
export const IDENTIFIER_POST_TRANSFORM_OPERATIONS: readonly string[] = [
  'affix_text',
  'case',
  'trim',
  'keep_part',
  'remove_text',
  'replace_text',
  'regex_replace',
  'to_halfwidth',
  'to_fullwidth',
  'strip_accents',
  'ascii_digits',
];

export interface MappingDependencyGraph {
  edgeCount: number;
  transforms: readonly { inputs: readonly MappingValueReference[] }[];
  output: MappingValueReference;
}

/** Validates ALL references, then walks the output in input order. Indexes are local to a rule. */
export function analyzeMappingDependencies(graph: MappingDependencyGraph): {
  stepIndexes: number[];
  edgeIndexes: Set<number>;
} {
  const check = (ref: MappingValueReference, before: number) => {
    const edge = 'edgeIndex' in ref;
    const step = 'stepIndex' in ref;
    const index = edge ? ref.edgeIndex : ref.stepIndex;
    if (
      edge === step ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= (edge ? graph.edgeCount : before)
    ) {
      throw new Error('invalid_reference');
    }
    if (
      ref.name !== undefined &&
      (typeof ref.name !== 'string' || !ref.name.trim() || ref.name.length > 518)
    ) {
      throw new Error('invalid_reference');
    }
  };
  graph.transforms.forEach((step, index) => step.inputs.forEach((ref) => check(ref, index)));
  check(graph.output, graph.transforms.length);
  const stepIndexes: number[] = [];
  const edgeIndexes = new Set<number>();
  const seen = new Set<number>();
  const visit = (ref: MappingValueReference) => {
    if ('edgeIndex' in ref) {
      edgeIndexes.add(ref.edgeIndex);
    } else if (!seen.has(ref.stepIndex)) {
      seen.add(ref.stepIndex);
      graph.transforms[ref.stepIndex].inputs.forEach(visit);
      stepIndexes.push(ref.stepIndex);
    }
  };
  visit(graph.output);
  return { stepIndexes, edgeIndexes };
}

export function identifierGraphProblem(rule: MappingRuleGraph): string | null {
  const identifierDependent: boolean[] = [];
  for (const [index, step] of rule.transforms.entries()) {
    const followsIdentifier = step.inputs.some(
      (ref) => 'stepIndex' in ref && identifierDependent[ref.stepIndex]
    );
    if (
      followsIdentifier &&
      (!IDENTIFIER_POST_TRANSFORM_OPERATIONS.includes(step.operation) ||
        rule.targetRef.namespace === 'saml.nameid' ||
        (rule.targetRef.path === 'sub' && rule.pairwiseSubject))
    ) {
      return 'identifier_post_transform_not_allowed';
    }
    identifierDependent[index] = followsIdentifier || step.operation === 'persistent_identifier';
  }
  return null;
}

/** Supply graph dependencies to existing source readers and asynchronous identifier preparation. */
export function withMappingGraph<
  T extends {
    edges: MappingRuleGraph['edges'];
    transforms?: import('./types').MappingTransformStep[];
    graphRules?: MappingRuleGraph[];
  },
>(binding: T) {
  if (!binding.graphRules) return { ...binding, transforms: binding.transforms ?? [] };
  const ownedEdges = new Set(
    binding.graphRules.flatMap((rule) => rule.edges.map((edge) => edge.id))
  );
  const ownedSteps = new Set(
    binding.graphRules.flatMap((rule) => rule.transforms.map((step) => step.id))
  );
  const edges = new Map(
    binding.edges.filter((edge) => !ownedEdges.has(edge.id)).map((edge) => [edge.id, edge])
  );
  const transforms = new Map(
    (binding.transforms ?? [])
      .filter((step) => !ownedSteps.has(step.id))
      .map((step) => [step.id, step])
  );
  for (const rule of binding.graphRules) {
    const dependencies = analyzeMappingDependencies({ ...rule, edgeCount: rule.edges.length });
    for (const index of dependencies.edgeIndexes)
      edges.set(rule.edges[index].id, rule.edges[index]);
    for (const index of dependencies.stepIndexes) {
      const step = rule.transforms[index];
      transforms.set(step.id, {
        ...step,
        inputNames: step.inputs.map((ref) => ref.name),
        outputTargetRef: rule.targetRef,
        inputEdgeIds: step.inputs.map((ref) =>
          'edgeIndex' in ref
            ? rule.edges[ref.edgeIndex].id
            : `step:${rule.transforms[ref.stepIndex].id}`
        ),
      });
    }
  }
  return { ...binding, edges: [...edges.values()], transforms: [...transforms.values()] };
}
