import { TRANSFORM_OPERATION_SCHEMAS } from '../core/transforms';
import type {
  FieldRef,
  MappingRuleEdge,
  MappingRuleGraph,
  MappingTransformStep,
} from '../core/types';

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
function field(value: unknown): FieldRef {
  const ref = record(value);
  const side = ref.side;
  return {
    ...ref,
    side:
      side === 'destination' || side === 'canonical' || side === 'derived' || side === 'review'
        ? side
        : 'source',
    namespace: text(ref.namespace, 'unknown'),
    path: text(ref.path ?? ref.fieldKey ?? ref.nodeId),
    catalogEntryId: typeof ref.catalogEntryId === 'string' ? ref.catalogEntryId : undefined,
    valueType: typeof ref.valueType === 'string' ? ref.valueType : undefined,
  };
}

/** Build explicit graphs at mocked resolver boundaries, including malformed boundary fixtures. */
export function withExplicitMappingGraphs<
  T extends {
    role?: 'idp' | 'sp' | 'op' | 'rp' | 'receiver';
    edges?: unknown;
    transforms?: unknown;
    graphRules?: MappingRuleGraph[];
    destinationFieldPolicies?: Record<string, 'required' | 'optional' | 'hidden'>;
  },
>(
  input: T,
  force?: boolean
): Omit<T, 'edges' | 'transforms'> & {
  edges: MappingRuleEdge[];
  transforms: MappingTransformStep[];
  graphRules: MappingRuleGraph[];
};
export function withExplicitMappingGraphs(input: null, force?: boolean): null;
export function withExplicitMappingGraphs<
  T extends {
    role?: 'idp' | 'sp' | 'op' | 'rp' | 'receiver';
    edges?: unknown;
    transforms?: unknown;
    graphRules?: MappingRuleGraph[];
    destinationFieldPolicies?: Record<string, 'required' | 'optional' | 'hidden'>;
  },
>(
  input: T | null,
  force = false
):
  | (Omit<T, 'edges' | 'transforms'> & {
      edges: MappingRuleEdge[];
      transforms: MappingTransformStep[];
      graphRules: MappingRuleGraph[];
    })
  | null {
  if (!input) return null;

  const edges: MappingRuleEdge[] = (Array.isArray(input.edges) ? input.edges : []).map(
    (value, index) => {
      const edge = record(value);
      return {
        ...edge,
        id: text(edge.id, String(index)),
        sourceRef: field(edge.sourceRef),
        targetRef: field(edge.targetRef),
        ruleId: typeof edge.ruleId === 'string' ? edge.ruleId : undefined,
      };
    }
  );
  const steps: MappingTransformStep[] = (
    Array.isArray(input.transforms) ? input.transforms : []
  ).map((value, index) => {
    const step = record(value);
    const schema = TRANSFORM_OPERATION_SCHEMAS.find((item) => item.operation === step.operation);
    if (!schema) throw new Error('transform.unsupported_operation');
    return {
      id: text(step.id, String(index)),
      operation: schema.operation,
      inputEdgeIds: Array.isArray(step.inputEdgeIds)
        ? step.inputEdgeIds.map((value) => text(value))
        : [],
      parameters: record(step.parameters),
      outputTargetRef: field(step.outputTargetRef),
      ...(typeof step.ruleId === 'string' ? { ruleId: step.ruleId } : {}),
    };
  });
  if (input.graphRules && !force)
    return { ...input, edges, transforms: steps, graphRules: input.graphRules };
  const consumed = new Set(steps.flatMap((step) => step.inputEdgeIds));
  const graphRules: MappingRuleGraph[] = edges
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
    const inputs = step.inputEdgeIds.flatMap((id) => edges.filter((edge) => edge.id === id));
    graphRules.push({
      id: step.ruleId ?? step.id,
      targetRef: step.outputTargetRef,
      edges: inputs,
      transforms: [
        {
          ...step,
          inputs: step.inputEdgeIds.map((id) => ({
            edgeIndex: inputs.findIndex((edge) => edge.id === id),
          })),
        },
      ],
      output: { stepIndex: 0 },
      writerOrder: edges.length + index,
      edgeValueReferences: 'target',
    });
  }
  return { ...input, edges, transforms: steps, graphRules };
}
