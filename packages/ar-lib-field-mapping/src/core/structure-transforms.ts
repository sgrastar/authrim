import { conditionFields, mappingConditionHolds, readMappingCondition } from './conditions';
import { failTransform } from './transform-safety';
import type { MappingTransformStep, TransformOperationSchema } from './types';

export const STRUCTURE_TRANSFORM_SCHEMAS: TransformOperationSchema[] = [
  {
    operation: 'json_extract_array',
    inputArity: { min: 1, max: 1 },
    parameters: [{ name: 'path', kind: 'string', required: true }],
    outputCardinality: 'multi',
    outputValueType: 'unknown',
  },
  {
    operation: 'json_extract_or',
    inputArity: { min: 1, max: 1 },
    parameters: [
      { name: 'path', kind: 'string', required: true },
      { name: 'defaultValue', kind: 'string', required: true },
      { name: 'nullAsMissing', kind: 'boolean', required: false },
    ],
    outputValueType: 'string',
    outputCardinality: 'single',
  },
  {
    operation: 'array_build',
    inputArity: { min: 1, max: 500 },
    parameters: [
      { name: 'omitEmpty', kind: 'boolean', required: false },
      { name: 'unique', kind: 'boolean', required: false },
    ],
    outputCardinality: 'multi',
  },
  {
    operation: 'hash',
    inputArity: { min: 1, max: 1 },
    parameters: [
      { name: 'encoding', kind: 'enum', required: true, allowedValues: ['hex', 'base64url'] },
    ],
    outputValueType: 'string',
    outputCardinality: 'single',
  },
  {
    operation: 'constant_text',
    inputArity: { min: 0, max: 0 },
    parameters: [{ name: 'value', kind: 'string', required: true }],
    outputValueType: 'string',
    outputCardinality: 'single',
  },
  {
    operation: 'constant_boolean',
    inputArity: { min: 0, max: 0 },
    parameters: [{ name: 'value', kind: 'boolean', required: true }],
    outputValueType: 'boolean',
    outputCardinality: 'single',
  },
  {
    operation: 'constant_number',
    inputArity: { min: 0, max: 0 },
    parameters: [{ name: 'value', kind: 'number', required: true }],
    outputValueType: 'number',
    outputCardinality: 'single',
  },
  {
    operation: 'conditional',
    inputArity: { min: 1, max: 65 },
    parameters: [
      { name: 'condition', kind: 'string', required: true },
      {
        name: 'valueType',
        kind: 'enum',
        required: true,
        allowedValues: ['as_text', 'as_boolean', 'as_number'],
      },
      { name: 'elseMode', kind: 'enum', required: true, allowedValues: ['as_is', 'none', 'fixed'] },
      { name: 'thenValue', kind: 'string', required: false },
      { name: 'elseValue', kind: 'string', required: false },
      { name: 'thenBool', kind: 'enum', required: false, allowedValues: ['true', 'false'] },
      { name: 'elseBool', kind: 'enum', required: false, allowedValues: ['true', 'false'] },
    ],
  },
];

export function conditionalInputsProblem(
  parameters: Record<string, unknown> | undefined,
  names: readonly (string | undefined)[]
): boolean {
  const condition = readMappingCondition(parameters?.condition);
  if (!condition) return true;
  const required = ['value', ...conditionFields(condition).map((field) => `field:${field}`)];
  return (
    names.length !== required.length ||
    new Set(names).size !== names.length ||
    required.some((name) => !names.includes(name))
  );
}

export function structureSettingsProblem(step: MappingTransformStep): boolean {
  const p = step.parameters ?? {};
  if (step.operation === 'constant_number')
    return (
      typeof p.value !== 'number' ||
      (!Number.isSafeInteger(p.value) &&
        (!Number.isFinite(p.value) || Math.abs(p.value) > Number.MAX_SAFE_INTEGER))
    );
  if (step.operation !== 'conditional') return false;
  if (conditionalInputsProblem(p, step.inputNames ?? [])) return true;
  const validBranch = (branch: 'then' | 'else') => {
    if (p.valueType === 'as_boolean')
      return p[`${branch}Bool`] === 'true' || p[`${branch}Bool`] === 'false';
    const value = p[`${branch}Value`];
    return (
      typeof value === 'string' &&
      (p.valueType !== 'as_number' ||
        (/^\s*-?\d+(\.\d+)?\s*$/u.test(value) &&
          Number.isFinite(Number(value)) &&
          Math.abs(Number(value)) <= Number.MAX_SAFE_INTEGER))
    );
  };
  return !validBranch('then') || (p.elseMode === 'fixed' && !validBranch('else'));
}

export function executeConditional(step: MappingTransformStep, values: unknown[]): unknown {
  const p = step.parameters ?? {};
  const condition = readMappingCondition(p.condition);
  if (!condition) failTransform('transform.invalid_parameter');
  const inputs = new Map(step.inputNames?.map((name, index) => [name ?? '', values[index]]));
  const typed = (branch: 'then' | 'else') =>
    p.valueType === 'as_boolean'
      ? p[`${branch}Bool`] === 'true'
      : p.valueType === 'as_number'
        ? Number(p[`${branch}Value`])
        : p[`${branch}Value`];
  if (mappingConditionHolds(condition, inputs)) return typed('then');
  return p.elseMode === 'none'
    ? null
    : p.elseMode === 'fixed'
      ? typed('else')
      : inputs.get('value');
}

/** Flatten one level; keep types, stable structural equality, discard null/absence. */
export function buildArray(
  values: unknown[],
  parameters: Record<string, unknown> | undefined
): unknown[] {
  const flattened: unknown[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      const items: unknown[] = value;
      flattened.push(...items);
    } else flattened.push(value);
  }
  const list = flattened.filter(
    (value) =>
      value !== undefined &&
      value !== null &&
      (!parameters?.omitEmpty || (value !== '' && !(Array.isArray(value) && value.length === 0)))
  );
  if (!parameters?.unique) return list;
  const seen = new Set<string>();
  return list.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
