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
    operation: 'as_array',
    parameters: [
      { name: 'trimItems', kind: 'boolean', required: false },
      { name: 'omitEmpty', kind: 'boolean', required: false },
      { name: 'unique', kind: 'boolean', required: false },
    ],
    outputCardinality: 'multi',
  },
  {
    operation: 'split',
    parameters: [
      { name: 'delimiter', kind: 'string', required: false },
      { name: 'trimItems', kind: 'boolean', required: false },
      { name: 'omitEmpty', kind: 'boolean', required: false },
      { name: 'unique', kind: 'boolean', required: false },
    ],
    outputCardinality: 'multi',
  },
  {
    operation: 'join',
    parameters: [
      { name: 'delimiter', kind: 'string', required: false },
      { name: 'trimItems', kind: 'boolean', required: false },
      { name: 'omitEmpty', kind: 'boolean', required: false },
      { name: 'unique', kind: 'boolean', required: false },
    ],
    outputValueType: 'string',
    outputCardinality: 'single',
  },
  {
    operation: 'first',
    parameters: [
      { name: 'trimItems', kind: 'boolean', required: false },
      { name: 'omitEmpty', kind: 'boolean', required: false },
    ],
    outputCardinality: 'single',
  },
  {
    operation: 'oidc_pairwise_sub',
    parameters: [{ name: 'persistentIdentifierProfileId', kind: 'string', required: false }],
    outputValueType: 'string',
    outputCardinality: 'single',
  },
  {
    operation: 'saml_edu_person_targeted_id',
    parameters: [{ name: 'persistentIdentifierProfileId', kind: 'string', required: false }],
    outputValueType: 'string',
    outputCardinality: 'single',
  },
  {
    operation: 'affix_text',
    parameters: [
      { name: 'prefix', kind: 'string', required: false },
      { name: 'suffix', kind: 'string', required: false },
    ],
    outputValueType: 'string',
    outputCardinality: 'single',
  },
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
  {
    operation: 'text_to_boolean',
    parameters: [
      { name: 'trueValues', kind: 'string', required: false },
      { name: 'falseValues', kind: 'string', required: false },
      { name: 'nullValues', kind: 'string', required: false },
    ],
    outputValueType: 'boolean',
    outputCardinality: 'single',
  },
  {
    operation: 'json_build',
    parameters: [
      { name: 'keyMap', kind: 'string', required: false },
      {
        name: 'nullHandling',
        kind: 'enum',
        required: true,
        allowedValues: ['omit', 'include_null'],
      },
    ],
    outputValueType: 'json',
    outputCardinality: 'single',
  },
  {
    operation: 'json_extract_text',
    parameters: [{ name: 'path', kind: 'string', required: true }],
    outputValueType: 'string',
    outputCardinality: 'single',
  },
  {
    operation: 'json_extract_boolean',
    parameters: [{ name: 'path', kind: 'string', required: true }],
    outputValueType: 'boolean',
    outputCardinality: 'single',
  },
  {
    operation: 'json_extract_integer',
    parameters: [{ name: 'path', kind: 'string', required: true }],
    outputValueType: 'number',
    outputCardinality: 'single',
  },
];

const transformSchemas = new Map(
  TRANSFORM_OPERATION_SCHEMAS.map((schema) => [schema.operation, schema])
);

const TRANSFORM_PARAMETER_MAX_CHARS = 2048;
const TRANSFORM_KEY_MAP_MAX_CHARS = 4096;
const TRANSFORM_JSON_MAX_BYTES = 32 * 1024;
const TRANSFORM_JSON_MAX_DEPTH = 12;
const TRANSFORM_JSON_MAX_NODES = 1000;
const TRANSFORM_JSON_MAX_ARRAY_ITEMS = 500;
const TRANSFORM_JSON_MAX_OBJECT_KEYS = 200;
const TRANSFORM_JSON_PATH_MAX_CHARS = 512;
const TRANSFORM_JSON_PATH_MAX_SEGMENTS = 32;

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
  const output = executeOperation(input.step, sourceValues, input.runtimeContext);

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

function executeOperation(
  step: MappingTransformStep,
  values: SourceValueEnvelope[],
  runtimeContext?: Record<string, unknown>
): unknown {
  const rawValues = values.map((item) => item.value);

  switch (step.operation) {
    case 'copy':
      return rawValues[0];
    case 'as_array':
      return normalizeArrayValue([rawValues[0]], step.parameters);
    case 'split':
      return splitValue(rawValues[0], step.parameters);
    case 'join':
      return normalizeArrayValue(rawValues, step.parameters).join(delimiter(step, ','));
    case 'first':
      return normalizeArrayValue(rawValues, step.parameters)[0] ?? null;
    case 'oidc_pairwise_sub':
      return buildOIDCPairwiseSub(runtimeContext, step.parameters);
    case 'saml_edu_person_targeted_id':
      return buildSAMLEduPersonTargetedID(runtimeContext);
    case 'affix_text':
      return affixText(rawValues[0], step.parameters);
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
    case 'text_to_boolean':
      return textToBoolean(rawValues[0], step.parameters);
    case 'json_build':
      return buildJsonValue(values, step.parameters);
    case 'json_extract_text':
      return extractTextValue(rawValues[0], step.parameters?.path);
    case 'json_extract_boolean':
      return textToBoolean(extractJsonValue(rawValues[0], step.parameters?.path), undefined);
    case 'json_extract_integer':
      return extractIntegerValue(rawValues[0], step.parameters?.path);
    default:
      return undefined;
  }
}

function delimiter(step: MappingTransformStep, fallback = ''): string {
  return typeof step.parameters?.delimiter === 'string' ? step.parameters.delimiter : fallback;
}

function buildOIDCPairwiseSub(
  runtimeContext?: Record<string, unknown>,
  parameters?: Record<string, unknown>
): string | undefined {
  const oidcContext = isRecord(runtimeContext?.oidc) ? runtimeContext.oidc : runtimeContext;
  const profileId = readString(parameters?.persistentIdentifierProfileId);
  const persistentIdentifiers = isRecord(oidcContext?.persistentIdentifiers)
    ? oidcContext.persistentIdentifiers
    : undefined;
  if (profileId) {
    return readString(persistentIdentifiers?.[profileId]);
  }
  return readString(oidcContext?.pairwiseSubject) ?? readString(oidcContext?.subject);
}

function buildSAMLEduPersonTargetedID(
  runtimeContext?: Record<string, unknown>
): string | undefined {
  const samlContext = isRecord(runtimeContext?.saml) ? runtimeContext.saml : runtimeContext;
  const localEntityId = readString(samlContext?.localEntityId);
  const partnerEntityId = readString(samlContext?.partnerEntityId);
  const opaqueId = readString(samlContext?.eduPersonTargetedIdOpaque);
  if (!localEntityId || !partnerEntityId || !opaqueId) {
    return undefined;
  }
  return `${localEntityId}!${partnerEntityId}!${opaqueId}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function affixText(value: unknown, parameters: Record<string, unknown> | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const body = String(value).trim();
  if (!body) {
    return null;
  }
  const prefix = typeof parameters?.prefix === 'string' ? parameters.prefix : '';
  const suffix = typeof parameters?.suffix === 'string' ? parameters.suffix : '';
  return `${prefix}${body}${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function splitValue(value: unknown, parameters: Record<string, unknown> | undefined): unknown[] {
  if (Array.isArray(value)) {
    return normalizeArrayValue(value, parameters);
  }
  if (value === undefined || value === null) {
    return normalizeArrayValue([], parameters);
  }
  if (typeof value !== 'string') {
    return normalizeArrayValue([value], parameters);
  }
  const separator =
    typeof parameters?.delimiter === 'string' && parameters.delimiter.length > 0
      ? parameters.delimiter
      : ',';
  return normalizeArrayValue(value.split(separator), parameters);
}

function normalizeArrayValue(
  value: unknown[],
  parameters: Record<string, unknown> | undefined
): unknown[] {
  const trimItems = booleanParameter(parameters?.trimItems);
  const omitEmpty = booleanParameter(parameters?.omitEmpty);
  const unique = booleanParameter(parameters?.unique);
  const flattened = value.flatMap((item) => (Array.isArray(item) ? item : [item]));
  const normalized = flattened
    .map((item) => (trimItems && typeof item === 'string' ? item.trim() : item))
    .filter((item) => !omitEmpty || !isEmptyArrayItem(item));
  if (!unique) {
    return normalized;
  }
  const seen = new Set<string>();
  return normalized.filter((item) => {
    const key = stableArrayItemKey(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function booleanParameter(value: unknown): boolean {
  return value === true || value === 'true';
}

function isEmptyArrayItem(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function stableArrayItemKey(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  }
  return `${typeof value}:${String(value)}`;
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

function textToBoolean(
  value: unknown,
  parameters: Record<string, unknown> | undefined
): boolean | null {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  const trueValues = parseTextValueSet(parameters?.trueValues, [
    'true',
    '1',
    'yes',
    'y',
    'on',
    'active',
    'enabled',
  ]);
  const falseValues = parseTextValueSet(parameters?.falseValues, [
    'false',
    '0',
    'no',
    'n',
    'off',
    'inactive',
    'disabled',
  ]);
  const nullValues = parseTextValueSet(parameters?.nullValues, [
    '',
    'null',
    'none',
    'n/a',
    'unknown',
  ]);

  if (trueValues.has(normalized)) {
    return true;
  }
  if (falseValues.has(normalized)) {
    return false;
  }
  if (nullValues.has(normalized)) {
    return null;
  }
  return null;
}

function parseTextValueSet(value: unknown, defaults: string[]): Set<string> {
  const source = typeof value === 'string' && value.trim().length > 0 ? value : defaults.join(',');
  const values = source
    .split(/[\n,]+/u)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  if (value === undefined) {
    values.push(...defaults.map((item) => item.trim().toLowerCase()));
  }
  return new Set(values);
}

function buildJsonValue(
  values: SourceValueEnvelope[],
  parameters: Record<string, unknown> | undefined
): Record<string, unknown> | unknown[] | null | undefined {
  if (values.length === 1) {
    const parsed = parseJsonText(values[0]?.value);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  const keyMap = parseKeyMap(parameters?.keyMap);
  const includeNulls = parameters?.nullHandling === 'include_null';
  const output: Record<string, unknown> = {};
  const seenKeys = new Set<string>();
  for (const source of values) {
    const rawValue = source.value;
    if (!includeNulls && (rawValue === undefined || rawValue === null || rawValue === '')) {
      continue;
    }
    const key = uniqueJsonKey(jsonBuildKey(source, keyMap), seenKeys);
    output[key] = parseJsonText(rawValue) ?? (rawValue === undefined ? null : rawValue);
  }
  return isJsonWithinBudget(output) ? output : undefined;
}

function parseKeyMap(value: unknown): Record<string, string> {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return {};
  }
  if (value.length > TRANSFORM_KEY_MAP_MAX_CHARS) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !isJsonWithinBudget(parsed) ||
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([key, mapped]) => [key, mapped.trim()])
        .filter(([, mapped]) => mapped.length > 0)
    );
  } catch {
    return {};
  }
}

function jsonBuildKey(source: SourceValueEnvelope, keyMap: Record<string, string>): string {
  const sourceKeys = [
    source.sourceRef.catalogEntryId,
    source.metadata?.columnName,
    source.metadata?.csvHeaderName,
    source.metadata?.fieldPath,
    source.sourceRef.path,
  ];
  for (const sourceKey of sourceKeys) {
    if (typeof sourceKey === 'string' && keyMap[sourceKey]) {
      return keyMap[sourceKey];
    }
  }
  const fallback =
    typeof source.metadata?.columnName === 'string'
      ? source.metadata.columnName
      : source.sourceRef.path.split('.').at(-1) || source.sourceRef.path;
  return sanitizeJsonKey(fallback);
}

function sanitizeJsonKey(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9_$]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'value';
}

function uniqueJsonKey(key: string, seenKeys: Set<string>): string {
  let candidate = key;
  let index = 2;
  while (seenKeys.has(candidate)) {
    candidate = `${key}_${index}`;
    index += 1;
  }
  seenKeys.add(candidate);
  return candidate;
}

function parseJsonText(value: unknown): Record<string, unknown> | unknown[] | undefined {
  if (value && typeof value === 'object') {
    return isJsonWithinBudget(value) ? (value as Record<string, unknown> | unknown[]) : undefined;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return undefined;
  }
  if (jsonByteLength(trimmed) > TRANSFORM_JSON_MAX_BYTES) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && isJsonWithinBudget(parsed)
      ? (parsed as Record<string, unknown> | unknown[])
      : undefined;
  } catch {
    return undefined;
  }
}

function extractTextValue(value: unknown, path: unknown): string | null {
  const extracted = extractJsonValue(value, path);
  if (extracted === undefined || extracted === null) {
    return null;
  }
  if (typeof extracted === 'string') {
    return extracted;
  }
  if (typeof extracted === 'number' || typeof extracted === 'boolean') {
    return String(extracted);
  }
  if (!isJsonWithinBudget(extracted)) {
    return null;
  }
  const serialized = JSON.stringify(extracted);
  return serialized.length <= TRANSFORM_PARAMETER_MAX_CHARS ? serialized : null;
}

function extractIntegerValue(value: unknown, path: unknown): number | null {
  const extracted = extractJsonValue(value, path);
  if (typeof extracted === 'number' && Number.isInteger(extracted)) {
    return extracted;
  }
  if (typeof extracted === 'string' && /^-?\d+$/.test(extracted.trim())) {
    return Number.parseInt(extracted.trim(), 10);
  }
  return null;
}

function extractJsonValue(value: unknown, path: unknown): unknown {
  const root = parseJsonText(value);
  if (root === undefined) {
    return undefined;
  }
  if (typeof path !== 'string' || path.trim().length === 0) {
    return root;
  }
  const segments = parseJsonPath(path);
  if (!segments) {
    return undefined;
  }
  let current: unknown = root;
  for (const segment of segments) {
    if (current === undefined || current === null) {
      return undefined;
    }
    if (typeof segment === 'number') {
      current = Array.isArray(current) ? current[segment] : undefined;
      continue;
    }
    current =
      typeof current === 'object' && !Array.isArray(current)
        ? (current as Record<string, unknown>)[segment]
        : undefined;
  }
  return current;
}

function parseJsonPath(path: string): Array<string | number> | null {
  if (path.length > TRANSFORM_JSON_PATH_MAX_CHARS) {
    return null;
  }
  const segments: Array<string | number> = [];
  for (const part of path.trim().split('.')) {
    const keyMatch = part.match(/^[^\[]+/u);
    if (keyMatch?.[0]) {
      segments.push(keyMatch[0]);
    }
    const indexMatches = part.matchAll(/\[(\d+)\]/gu);
    for (const match of indexMatches) {
      segments.push(Number.parseInt(match[1] ?? '0', 10));
    }
  }
  return segments.length <= TRANSFORM_JSON_PATH_MAX_SEGMENTS ? segments : null;
}

function isTransformOutputValid(operation: TransformOperation, value: unknown): boolean {
  const schema = transformSchemas.get(operation);
  if (!schema?.outputValueType) {
    return true;
  }
  if (
    schema.outputValueType !== 'json' &&
    schema.outputCardinality === 'single' &&
    Array.isArray(value)
  ) {
    return false;
  }
  if (value === null) {
    return true;
  }
  if (schema.outputValueType === 'string') {
    return typeof value === 'string';
  }
  if (schema.outputValueType === 'boolean') {
    return typeof value === 'boolean';
  }
  if (schema.outputValueType === 'number') {
    return typeof value === 'number' && Number.isFinite(value);
  }
  if (schema.outputValueType === 'json') {
    return typeof value === 'object' && isJsonWithinBudget(value);
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
      if (typeof value !== 'string') {
        return false;
      }
      if (parameter.name === 'path') {
        return value.length <= TRANSFORM_JSON_PATH_MAX_CHARS && parseJsonPath(value) !== null;
      }
      if (parameter.name === 'keyMap') {
        return value.length <= TRANSFORM_KEY_MAP_MAX_CHARS;
      }
      return value.length <= TRANSFORM_PARAMETER_MAX_CHARS;
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

function isJsonWithinBudget(value: unknown): boolean {
  const seen = new WeakSet<object>();
  let nodeCount = 0;

  const visit = (item: unknown, depth: number): boolean => {
    nodeCount += 1;
    if (nodeCount > TRANSFORM_JSON_MAX_NODES || depth > TRANSFORM_JSON_MAX_DEPTH) {
      return false;
    }
    if (typeof item === 'string' && item.length > TRANSFORM_PARAMETER_MAX_CHARS) {
      return false;
    }
    if (item === undefined || item === null || typeof item !== 'object') {
      return true;
    }
    if (seen.has(item)) {
      return false;
    }
    seen.add(item);
    if (Array.isArray(item)) {
      return (
        item.length <= TRANSFORM_JSON_MAX_ARRAY_ITEMS &&
        item.every((child) => visit(child, depth + 1))
      );
    }
    const entries = Object.entries(item);
    return (
      entries.length <= TRANSFORM_JSON_MAX_OBJECT_KEYS &&
      entries.every(([, child]) => visit(child, depth + 1))
    );
  };

  return visit(value, 0) && jsonByteLength(value) <= TRANSFORM_JSON_MAX_BYTES;
}

function jsonByteLength(value: unknown): number {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return new TextEncoder().encode(text).length;
}
