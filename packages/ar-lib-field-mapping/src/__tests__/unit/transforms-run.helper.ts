import { executeTransformStep } from '../../core/transforms';
import type {
  FieldRef,
  MappingTransformStep,
  SourceValueEnvelope,
  TransformExecutionResult,
  TransformOperation,
} from '../../core/types';

export const target: FieldRef = {
  side: 'canonical',
  namespace: 'authrim.profile',
  path: 'result',
};

export interface RunOptions {
  id?: string;
  runtimeContext?: Record<string, unknown>;
  inputNames?: (string | undefined)[];
  workBudget?: { remaining: number };
  envelopes?: SourceValueEnvelope[];
}

export function run(
  operation: TransformOperation,
  values: unknown[],
  parameters?: Record<string, unknown>,
  options: RunOptions = {}
): TransformExecutionResult {
  const step: MappingTransformStep = {
    id: options.id ?? `transform.${operation}`,
    inputEdgeIds: values.map((_, index) => `edge-${index}`),
    inputNames: options.inputNames,
    operation,
    parameters,
    outputTargetRef: target,
  };
  const edgeValues = new Map<string, SourceValueEnvelope>(
    values.map((value, index) => [
      `edge-${index}`,
      options.envelopes?.[index] ?? {
        value,
        sourceRef: { side: 'source', namespace: 'csv', path: `field-${index}` },
      },
    ])
  );
  return executeTransformStep({
    step,
    edgeValues,
    runtimeContext: options.runtimeContext,
    workBudget: options.workBudget,
  });
}
