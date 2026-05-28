import { buildTraceEntry } from './trace';
import { reason } from './reason-registry';
import { statusFromReasons } from './result';
import type {
  MappingTransformStep,
  ReasonCode,
  SourceValueEnvelope,
  TransformOperation,
  TransformExecutionInput,
  TransformExecutionResult,
  TransformOperationSchema,
  ValidationResult,
} from './types';

export const TRANSFORM_OPERATION_SCHEMAS: TransformOperationSchema[] = [
  { operation: 'copy', parameters: [] },
  {
    operation: 'concat',
    parameters: [{ name: 'delimiter', kind: 'string', required: false }],
    outputValueType: 'string',
    outputCardinality: 'single',
  },
  { operation: 'fallback', parameters: [] },
  {
    operation: 'normalize',
    parameters: [
      {
        name: 'mode',
        kind: 'enum',
        required: true,
        allowedValues: ['whitespace', 'unicode'],
      },
    ],
    outputValueType: 'string',
    outputCardinality: 'single',
  },
  {
    operation: 'case',
    parameters: [
      {
        name: 'mode',
        kind: 'enum',
        required: true,
        allowedValues: ['lower', 'upper', 'title'],
      },
    ],
    outputValueType: 'string',
    outputCardinality: 'single',
  },
  {
    operation: 'trim',
    parameters: [],
    outputValueType: 'string',
    outputCardinality: 'single',
  },
];

const transformSchemas = new Map(
  TRANSFORM_OPERATION_SCHEMAS.map((schema) => [schema.operation, schema])
);

export function validateTransformStep(step: MappingTransformStep): ValidationResult {
  const reasons: ReasonCode[] = [];
  const schema = transformSchemas.get(step.operation);

  if (!schema) {
    reasons.push(reason('transform.unsupported_operation'));
    return resultFromReasons(reasons);
  }

  const parameters = step.parameters ?? {};
  const schemaParameters = new Map(
    schema.parameters.map((parameter) => [parameter.name, parameter])
  );

  for (const parameter of schema.parameters) {
    if (parameter.required && !(parameter.name in parameters)) {
      reasons.push(reason('transform.missing_parameter'));
      continue;
    }
    if (
      parameter.name in parameters &&
      !isParameterValueValid(parameter, parameters[parameter.name])
    ) {
      reasons.push(reason('transform.invalid_parameter'));
    }
  }

  for (const name of Object.keys(parameters)) {
    if (!schemaParameters.has(name)) {
      reasons.push(reason('transform.unknown_parameter'));
    }
  }

  return resultFromReasons(reasons);
}

export function executeTransformStep(input: TransformExecutionInput): TransformExecutionResult {
  const validation = validateTransformStep(input.step);
  const reasons: ReasonCode[] = [...validation.reasons];

  if (hasBlockingTransformIssue(reasons)) {
    return transformResult(input, reasons);
  }

  const values = input.step.inputEdgeIds.map((edgeId) => input.edgeValues.get(edgeId));

  if (values.some((value) => !value)) {
    reasons.push(reason('transform.missing_input'));
    return transformResult(input, reasons);
  }

  const sourceValues = values.filter(Boolean) as SourceValueEnvelope[];
  const output = executeOperation(input.step, sourceValues);

  if (!isTransformOutputValid(input.step.operation, output)) {
    reasons.push(reason('transform.invalid_output'));
    return transformResult(input, reasons);
  }

  const firstSource = sourceValues[0];
  return {
    status: statusFromReasons(reasons),
    value: {
      value: output,
      sourceRef: input.step.outputTargetRef,
      metadata: firstSource?.metadata,
      classificationHint: firstSource?.classificationHint,
      provenanceHint: firstSource?.provenanceHint,
    },
    reasons,
    trace: [
      ...validation.trace,
      buildTraceEntry({
        reason: reason('trace.transform_evaluated'),
        action: 'transformed',
        transformStepId: input.step.id,
        fieldRef: input.step.outputTargetRef,
      }),
    ],
  };
}

function hasBlockingTransformIssue(reasons: ReasonCode[]): boolean {
  return reasons.some((item) => item.severity === 'error' || item.severity === 'critical');
}

export function validateTransformRegistry(schemas = TRANSFORM_OPERATION_SCHEMAS): string[] {
  const errors: string[] = [];
  const seen = new Set<TransformOperation>();
  for (const schema of schemas) {
    if (seen.has(schema.operation)) {
      errors.push(`duplicate transform operation: ${schema.operation}`);
    }
    seen.add(schema.operation);
  }
  return errors;
}

function transformResult(
  input: TransformExecutionInput,
  reasons: ReasonCode[]
): TransformExecutionResult {
  return {
    status: statusFromReasons(reasons),
    reasons,
    trace: [
      ...reasons.map((item) => buildTraceEntry({ reason: item, transformStepId: input.step.id })),
    ],
  };
}

function executeOperation(step: MappingTransformStep, values: SourceValueEnvelope[]): unknown {
  const rawValues = values.map((item) => item.value);

  switch (step.operation) {
    case 'copy':
      return rawValues[0];
    case 'concat':
      return rawValues.filter((item) => item !== undefined && item !== null).join(delimiter(step));
    case 'fallback':
      return rawValues.find((item) => item !== undefined && item !== null && item !== '');
    case 'normalize':
      return normalizeValue(rawValues[0], step.parameters?.mode);
    case 'case':
      return caseValue(rawValues[0], step.parameters?.mode);
    case 'trim':
      return typeof rawValues[0] === 'string' ? rawValues[0].trim() : rawValues[0];
    default:
      return undefined;
  }
}

function delimiter(step: MappingTransformStep): string {
  return typeof step.parameters?.delimiter === 'string' ? step.parameters.delimiter : '';
}

function normalizeValue(value: unknown, mode: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  if (mode === 'unicode') {
    return value.normalize('NFKC');
  }
  return value.replace(/\s+/g, ' ').trim();
}

function caseValue(value: unknown, mode: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  if (mode === 'upper') {
    return value.toUpperCase();
  }
  if (mode === 'title') {
    return value.replace(/\b\p{L}/gu, (match) => match.toUpperCase());
  }
  return value.toLowerCase();
}

function isTransformOutputValid(operation: TransformOperation, value: unknown): boolean {
  const schema = transformSchemas.get(operation);
  if (!schema?.outputValueType) {
    return true;
  }
  if (schema.outputCardinality === 'single' && Array.isArray(value)) {
    return false;
  }
  if (schema.outputValueType === 'string') {
    return typeof value === 'string';
  }
  return true;
}

function resultFromReasons(reasons: ReasonCode[]): ValidationResult {
  return {
    status: statusFromReasons(reasons),
    reasons,
    trace: reasons.map((item) => buildTraceEntry({ reason: item })),
  };
}

function isParameterValueValid(
  parameter: TransformOperationSchema['parameters'][number],
  value: unknown
): boolean {
  switch (parameter.kind) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
    case 'string-array':
      return Array.isArray(value) && value.every((item) => typeof item === 'string');
    case 'enum':
      return typeof value === 'string' && (parameter.allowedValues ?? []).includes(value);
    case 'field-ref':
      return typeof value === 'object' && value !== null;
    default:
      return false;
  }
}
