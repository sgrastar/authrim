import type { MappingRuleEdge, MappingTransformStep, MappingRuleGraph } from './types';

/**
 * TODO(W1b): replace reconstruction with persisted rule inputs and output. A row group with one
 * edge can represent independent steps reading that edge and a last-step output. Legacy groups
 * with several edges/targets remain on the compatibility evaluator until migration. Reconstructed
 * rules always release only their output, including competing writers. Runtime merges outputs at
 * their original edge/last-step positions to retain writer order without releasing intermediates.
 * rule_id is an existing column, not new stored metadata. A dangling row is refused, never a copy.
 */
export function partitionStoredMappingGraph(
  edges: MappingRuleEdge[],
  transforms: MappingTransformStep[]
): {
  graphRules: MappingRuleGraph[];
  edges: MappingRuleEdge[];
  transforms: MappingTransformStep[];
} {
  const graphRules: MappingRuleGraph[] = [];
  const consumed = new Set<string>();
  const ids = new Set([
    ...edges.map((edge) => edge.ruleId),
    ...transforms.map((step) => step.ruleId),
  ]);
  for (const id of ids) {
    if (!id) continue;
    const ruleEdges = edges.filter((edge) => edge.ruleId === id);
    const steps = transforms.filter((step) => step.ruleId === id);
    if (ruleEdges.length > 1) continue;
    const targetRef = steps.at(-1)?.outputTargetRef ?? ruleEdges[0]?.targetRef;
    if (!targetRef) continue;
    if (ruleEdges.some((edge) => !sameTarget(edge.targetRef, targetRef))) continue;
    if (steps.some((step) => !sameTarget(step.outputTargetRef, targetRef))) continue;
    graphRules.push({
      id,
      targetRef,
      edges: ruleEdges,
      transforms: steps.map((step) => ({
        id: step.id,
        operation: step.operation,
        parameters: step.parameters,
        inputs: step.inputEdgeIds.map((edgeId) => ({
          edgeIndex: ruleEdges.findIndex((edge) => edge.id === edgeId),
        })),
      })),
      output: steps.length ? { stepIndex: steps.length - 1 } : { edgeIndex: 0 },
    });
    consumed.add(id);
  }
  return {
    graphRules,
    edges: edges.filter((edge) => !edge.ruleId || !consumed.has(edge.ruleId)),
    transforms: transforms.filter((step) => !step.ruleId || !consumed.has(step.ruleId)),
  };
}

function sameTarget(a: MappingRuleEdge['targetRef'], b: MappingRuleEdge['targetRef']): boolean {
  return a.side === b.side && a.namespace === b.namespace && a.path === b.path;
}
