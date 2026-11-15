import type { MappingInput, MappingRuleGraph } from '../core/types';

/** Explicit graphs for operation tests written with an edge/transform fixture DSL. */
export function graphFixture(input: MappingInput): MappingInput {
  if (input.graphRules) return input;
  const steps = input.transforms ?? [];
  const consumed = new Set(steps.flatMap((step) => step.inputEdgeIds));
  const graphRules: MappingRuleGraph[] = input.edges
    .filter((edge) => !consumed.has(edge.id))
    .map((edge, index) => ({
      id: edge.ruleId ?? edge.id,
      targetRef: edge.targetRef,
      edges: [edge],
      transforms: [],
      output: { edgeIndex: 0 },
      writerOrder: index,
    }));
  for (const [index, step] of steps.entries()) {
    const edges = step.inputEdgeIds.flatMap((id) => input.edges.filter((edge) => edge.id === id));
    graphRules.push({
      id: step.ruleId ?? step.id,
      targetRef: step.outputTargetRef,
      edges,
      transforms: [
        {
          ...step,
          inputs: step.inputEdgeIds.map((id) => ({
            edgeIndex: edges.findIndex((edge) => edge.id === id),
          })),
        },
      ],
      output: { stepIndex: 0 },
      writerOrder: input.edges.length + index,
      edgeValueReferences: 'target',
    });
  }
  return { ...input, graphRules };
}
