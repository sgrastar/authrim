import { analyzeMappingDependencies } from './graph';
import { buildTraceEntry } from './trace';
import { reason } from './reason-registry';
import { statusFromReasons } from './result';
import type {
  FieldRef,
  MappingRuleEdge,
  MappingRuleGraph,
  MappingTransformStep,
  ReasonCode,
  SourceValueEnvelope,
  TransformOperation,
  TransformExecutionInput,
  TransformExecutionResult,
  TransformOperationSchema,
  ValidationResult,
} from './types';

/** How a persistent identifier is framed for its protocol. */
export const PERSISTENT_IDENTIFIER_FORMATS = [
  'plain',
  'saml_targeted_id',
  'saml_pairwise_id',
  'saml_subject_id',
] as const;
/** Kept in step with IDENTIFIER_ALGORITHMS in @authrim/ar-lib-core (identifier-algorithms.ts). */
export const PERSISTENT_IDENTIFIER_ALGORITHMS = [
  'authrim_sha256',
  'shibboleth',
  'keycloak_sha256',
  'simplesamlphp_targeted_id',
  'simplesamlphp_persistent_nameid',
  'simplesamlphp_pairwise_id',
  'simplesamlphp_subject_id',
] as const;

/**
 * The name an imported salt is kept under (identifier-salt:import:<name>); also the names of the
 * stores of stored identifiers and of the identifier sources.
 */
export const IDENTIFIER_SALT_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/u;

/**
 * The algorithms that make an identifier with a salt (all of them today): the ones a per-account
 * salt override (the `exceptions` list) can apply to.
 */
const SALTED_ALGORITHMS: readonly string[] = PERSISTENT_IDENTIFIER_ALGORITHMS;

/** What a persistent identifier is made from: the account ID, or a dedicated identifier source. */
export const PERSISTENT_IDENTIFIER_INPUTS = ['account', 'source'] as const;

const IDENTIFIER_SCOPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,126}$/u;

/**
 * What is wrong with a persistent_identifier step's settings, or null. Shared by saving (the
 * admin API) and running, so a set that could never make an identifier is neither saved nor run.
 * Which protocol it is for is checked where the identifier is made.
 */
export function persistentIdentifierSettingsProblem(
  parameters: Record<string, unknown> | undefined
): string | null {
  const p = parameters ?? {};
  const format = p.format;
  const algorithm = p.algorithm;
  if (
    typeof format !== 'string' ||
    !(PERSISTENT_IDENTIFIER_FORMATS as readonly string[]).includes(format)
  ) {
    return 'format';
  }
  if (
    typeof algorithm !== 'string' ||
    !(PERSISTENT_IDENTIFIER_ALGORITHMS as readonly string[]).includes(algorithm)
  ) {
    return 'algorithm';
  }
  // What it is made from: the account's ID, or a value an administrator imported for the account
  // (an identifier source, by name). Never a value read from the person's own attributes.
  if (
    typeof p.input !== 'string' ||
    !(PERSISTENT_IDENTIFIER_INPUTS as readonly string[]).includes(p.input)
  ) {
    return 'input';
  }
  if (
    p.input === 'source'
      ? typeof p.source !== 'string' || !IDENTIFIER_SALT_NAME.test(p.source)
      : p.source !== undefined
  ) {
    return 'source';
  }
  // A salt brought from another identity provider, by the name it was imported under.
  if (p.salt !== undefined && (typeof p.salt !== 'string' || !IDENTIFIER_SALT_NAME.test(p.salt))) {
    return 'salt';
  }
  // The exceptions list (a per-account salt override, or no identifier at all) by name: only for an
  // algorithm that takes a salt.
  if (
    p.exceptions !== undefined &&
    (typeof p.exceptions !== 'string' ||
      !IDENTIFIER_SALT_NAME.test(p.exceptions) ||
      !SALTED_ALGORITHMS.includes(algorithm))
  ) {
    return 'exceptions';
  }
  // What each algorithm makes: an identifier per recipient, or one for every recipient.
  const fits: Record<string, readonly string[]> = {
    authrim_sha256: ['plain', 'saml_targeted_id', 'saml_pairwise_id'],
    shibboleth: ['plain', 'saml_targeted_id', 'saml_pairwise_id'],
    keycloak_sha256: ['plain'],
    simplesamlphp_targeted_id: ['plain', 'saml_targeted_id'],
    simplesamlphp_persistent_nameid: ['plain', 'saml_targeted_id'],
    simplesamlphp_pairwise_id: ['saml_pairwise_id'],
    // The same for every recipient: never released as a per-recipient identifier.
    simplesamlphp_subject_id: ['saml_subject_id'],
  };
  if (!fits[algorithm]?.includes(format)) return 'format_algorithm';
  const stored = p.stored ?? 'off';
  if (
    (stored !== 'off' && (typeof p.store !== 'string' || !IDENTIFIER_SALT_NAME.test(p.store))) ||
    (p.store !== undefined && stored === 'off')
  ) {
    return 'store';
  }
  if ((p.digest !== undefined || p.encoding !== undefined) && algorithm !== 'shibboleth') {
    return 'digest_or_encoding';
  }
  const scoped =
    format === 'saml_pairwise_id' ||
    format === 'saml_subject_id' ||
    algorithm === 'simplesamlphp_pairwise_id' ||
    algorithm === 'simplesamlphp_subject_id';
  if (
    p.scope !== undefined &&
    (typeof p.scope !== 'string' || !IDENTIFIER_SCOPE_PATTERN.test(p.scope))
  ) {
    return 'scope';
  }
  if (scoped && p.scope === undefined) return 'scope';
  return null;
}

/**
 * Another edge into a persistent identifier's own output: its value would go out there as well,
 * next to or in place of the identifier. (The step takes no input edge; it is made from the
 * account ID or an identifier source, which the runtime supplies.)
 */
export function sharesConsumedInput(
  transforms: readonly MappingTransformStep[] = [],
  edges: readonly MappingRuleEdge[] = []
): boolean {
  const identifierTargets = transforms
    .filter((step) => step.operation === 'persistent_identifier')
    .map((step) => step.outputTargetRef);
  return edges.some((edge) =>
    identifierTargets.some((target) => sameTarget(target, edge.targetRef))
  );
}

function sameTarget(a: FieldRef, b: FieldRef): boolean {
  if (a.catalogEntryId && b.catalogEntryId) return a.catalogEntryId === b.catalogEntryId;
  return (
    (a.side ?? 'source') === (b.side ?? 'source') &&
    a.namespace === b.namespace &&
    a.path === b.path
  );
}

export const TRANSFORM_OPERATION_SCHEMAS: TransformOperationSchema[] = [
  { operation: 'copy', inputArity: { min: 1, max: 1 }, parameters: [] },
  {
    operation: 'as_array',
    inputArity: { min: 1, max: 1 },
    parameters: [
      { name: 'trimItems', kind: 'boolean', required: false },
      { name: 'omitEmpty', kind: 'boolean', required: false },
      { name: 'unique', kind: 'boolean', required: false },
    ],
    outputCardinality: 'multi',
  },
  {
    operation: 'split',
    inputArity: { min: 1, max: 1 },
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
    inputArity: { min: 1 },
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
    inputArity: { min: 1 },
    parameters: [
      { name: 'trimItems', kind: 'boolean', required: false },
      { name: 'omitEmpty', kind: 'boolean', required: false },
    ],
    outputCardinality: 'single',
  },
  {
    // Made before the mapping runs (it needs a salt and hashing, which are asynchronous): the
    // step only takes the value prepared for it, by its id, from runtimeContext.identifiers. It
    // takes no input edge: it is made from the account's ID, or from a value an administrator
    // imported for the account (`input` and `source`), which the runtime reads, not the mapping.
    operation: 'persistent_identifier',
    inputArity: { min: 0, max: 0 },
    parameters: [
      {
        name: 'input',
        kind: 'enum',
        required: true,
        allowedValues: [...PERSISTENT_IDENTIFIER_INPUTS],
      },
      { name: 'source', kind: 'string', required: false },
      {
        name: 'format',
        kind: 'enum',
        required: true,
        allowedValues: [...PERSISTENT_IDENTIFIER_FORMATS],
      },
      {
        name: 'algorithm',
        kind: 'enum',
        required: true,
        allowedValues: [...PERSISTENT_IDENTIFIER_ALGORITHMS],
      },
      {
        name: 'digest',
        kind: 'enum',
        required: false,
        allowedValues: ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'],
      },
      { name: 'encoding', kind: 'enum', required: false, allowedValues: ['base64', 'base32'] },
      {
        name: 'audience',
        kind: 'enum',
        required: false,
        allowedValues: ['auto', 'sector', 'sp_entity_id'],
      },
      { name: 'scope', kind: 'string', required: false },
      { name: 'salt', kind: 'string', required: false },
      // The list of exceptions (per account and recipient: another imported salt, or no identifier).
      { name: 'exceptions', kind: 'string', required: false },
      // Identifiers kept from another IdP: used first (prefer), or only (require).
      {
        name: 'stored',
        kind: 'enum',
        required: false,
        allowedValues: ['off', 'prefer', 'require'],
      },
      { name: 'store', kind: 'string', required: false },
      { name: 'sourceMetadataSet', kind: 'string', required: false },
      { name: 'destinationMetadataSet', kind: 'string', required: false },
    ],
    outputValueType: 'string',
    outputCardinality: 'single',
  },
  {
    operation: 'affix_text',
    inputArity: { min: 1, max: 1 },
    parameters: [
      { name: 'prefix', kind: 'string', required: false },
      { name: 'suffix', kind: 'string', required: false },
    ],
    outputValueType: 'string',
    outputCardinality: 'single',
  },
  {
    operation: 'concat',
    inputArity: { min: 1 },
    parameters: [{ name: 'delimiter', kind: 'string', required: false }],
    outputValueType: 'string',
    outputCardinality: 'single',
  },
  { operation: 'fallback', inputArity: { min: 1 }, parameters: [] },
  {
    operation: 'normalize',
    inputArity: { min: 1, max: 1 },
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
    inputArity: { min: 1, max: 1 },
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
    inputArity: { min: 1, max: 1 },
    parameters: [],
    outputValueType: 'string',
    outputCardinality: 'single',
  },
  {
    operation: 'text_to_boolean',
    inputArity: { min: 1, max: 1 },
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
    inputArity: { min: 1 },
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
    inputArity: { min: 1, max: 1 },
    parameters: [{ name: 'path', kind: 'string', required: true }],
    outputValueType: 'string',
    outputCardinality: 'single',
  },
  {
    operation: 'json_extract_boolean',
    inputArity: { min: 1, max: 1 },
    parameters: [{ name: 'path', kind: 'string', required: true }],
    outputValueType: 'boolean',
    outputCardinality: 'single',
  },
  {
    operation: 'json_extract_integer',
    inputArity: { min: 1, max: 1 },
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

  if (
    step.inputEdgeIds.length < schema.inputArity.min ||
    (schema.inputArity.max !== undefined && step.inputEdgeIds.length > schema.inputArity.max)
  ) {
    reasons.push(reason('transform.invalid_arity'));
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

  if (
    input.step.operation === 'persistent_identifier' &&
    (hasBlockingTransformIssue(reasons) ||
      persistentIdentifierSettingsProblem(input.step.parameters) !== null)
  ) {
    // Settings that cannot make an identifier stop the release, like a missing identifier.
    reasons.push(reason('transform.identifier_unavailable'));
    return transformResult(input, reasons);
  }

  if (hasBlockingTransformIssue(reasons)) {
    return transformResult(input, reasons);
  }

  const values = input.step.inputEdgeIds.map((edgeId) => input.edgeValues.get(edgeId));

  if (input.step.operation === 'persistent_identifier') {
    // No input edge (a saved version that has one is refused), and the value made for this
    // step: anything else stops the release rather than letting it go out without the identifier
    // (or with something else in its place).
    if (
      input.step.inputEdgeIds.length === 0 &&
      isSuppressedIdentifier(input.step, input.runtimeContext)
    ) {
      // An exception says no identifier is made for this account and recipient: the target gets no
      // value (the caller drops any other one it holds, and refuses when the target is required).
      return transformResult(input, reasons);
    }
    const made = readPreparedIdentifier(input.step, input.runtimeContext);
    if (input.step.inputEdgeIds.length !== 0 || !made) {
      reasons.push(reason('transform.identifier_unavailable'));
      return transformResult(input, reasons);
    }
  }

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
      return normalizeArrayValue(
        rawValues.filter((value) => value !== undefined),
        step.parameters
      ).join(delimiter(step, ','));
    case 'first':
      return (
        normalizeArrayValue(
          rawValues.filter((value) => value !== undefined),
          step.parameters
        )[0] ?? null
      );
    case 'persistent_identifier':
      return readPreparedIdentifier(step, runtimeContext);
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

/** Whether the runtime suppressed this step's identifier (an exception says none is made). */
function isSuppressedIdentifier(
  step: MappingTransformStep,
  runtimeContext?: Record<string, unknown>
): boolean {
  const suppressed = isRecord(runtimeContext?.suppressedIdentifiers)
    ? runtimeContext.suppressedIdentifiers
    : undefined;
  return suppressed?.[step.id] === true;
}

/** The identifier prepared for this step before the mapping ran, if there is one. */
function readPreparedIdentifier(
  step: MappingTransformStep,
  runtimeContext?: Record<string, unknown>
): string | undefined {
  const identifiers = isRecord(runtimeContext?.identifiers)
    ? runtimeContext.identifiers
    : undefined;
  const value = identifiers ? identifiers[step.id] : undefined;
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
    if (rawValue === undefined || (!includeNulls && (rawValue === null || rawValue === ''))) {
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
    const keyMatch = part.match(/^[^[]+/u);
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

/**
 * The mapped values without any made for the target of a suppressed persistent_identifier step (an
 * exception says no identifier is made): another rule's step or edge writing the same target goes
 * with it, so nothing is released where the identifier was refused. Shared by the runtime and the
 * dry run, so the two report the same.
 */
export function dropSuppressedTargets(
  values: SourceValueEnvelope[],
  transforms: readonly MappingTransformStep[] | undefined,
  runtimeContext: Record<string, unknown> | undefined,
  graphRules: readonly MappingRuleGraph[] = []
): SourceValueEnvelope[] {
  const suppressed = runtimeContext?.suppressedIdentifiers;
  if (typeof suppressed !== 'object' || suppressed === null) return values;
  const flags = suppressed as Record<string, unknown>;
  const targets = (transforms ?? []).filter(
    (step) => step.operation === 'persistent_identifier' && flags[step.id] === true
  );
  const graphTargets: FieldRef[] = [];
  for (const rule of graphRules) {
    try {
      const dependencies = analyzeMappingDependencies({ ...rule, edgeCount: rule.edges.length });
      if (
        dependencies.stepIndexes.some(
          (index) =>
            rule.transforms[index].operation === 'persistent_identifier' &&
            flags[rule.transforms[index].id] === true
        )
      ) {
        graphTargets.push(rule.targetRef);
      }
    } catch {
      // Invalid loaded graphs fail closed even when the context carries suppression flags.
      return [];
    }
  }
  if (targets.length === 0 && graphTargets.length === 0) return values;
  return values.filter(
    (value) =>
      ![...targets.map((step) => step.outputTargetRef), ...graphTargets].some(
        (target) =>
          target.side === value.sourceRef.side &&
          target.namespace === value.sourceRef.namespace &&
          target.path === value.sourceRef.path
      )
  );
}
