import { buildTraceEntry } from './trace';
import { reason } from './reason-registry';
import { statusFromReasons } from './result';
import type {
  MappingTransformStep,
  ReasonCode,
  TransformOperation,
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
