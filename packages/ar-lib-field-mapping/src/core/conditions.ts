import {
  failTransform,
  measureTransformValue,
  safeTransformPattern,
  TRANSFORM_LIMITS,
} from './transform-safety';

export type MappingCondition =
  | { kind: 'group'; match: 'all' | 'any' | 'none'; children: MappingCondition[] }
  | { kind: 'rule'; field: string; operator: string; value: unknown };

const operators = [
  'eq',
  'ne',
  'in',
  'not_in',
  'contains',
  'not_contains',
  'lt',
  'lte',
  'gt',
  'gte',
  'exists',
  'not_exists',
  'regex',
];
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Console condition JSON. Refuse unbounded trees before walking or running a pattern. */
export function readMappingCondition(text: unknown): MappingCondition | undefined {
  if (
    typeof text !== 'string' ||
    new TextEncoder().encode(text).length > TRANSFORM_LIMITS.tableBytes
  )
    return undefined;
  try {
    const raw: unknown = JSON.parse(text);
    measureTransformValue(raw);
    let nodes = 0;
    const valid = (node: unknown, depth: number): node is MappingCondition => {
      if (
        ++nodes > TRANSFORM_LIMITS.conditionNodes ||
        depth > TRANSFORM_LIMITS.conditionDepth ||
        !record(node)
      )
        return false;
      if (node.kind === 'group')
        return (
          typeof node.match === 'string' &&
          ['all', 'any', 'none'].includes(node.match) &&
          Array.isArray(node.children) &&
          node.children.length > 0 &&
          node.children.every((child) => valid(child, depth + 1))
        );
      if (
        node.kind !== 'rule' ||
        typeof node.field !== 'string' ||
        !node.field ||
        node.field.length > 512 ||
        typeof node.operator !== 'string' ||
        !operators.includes(node.operator)
      )
        return false;
      const value = node.value;
      if (node.operator === 'exists' || node.operator === 'not_exists') return value === null;
      if (node.operator === 'regex')
        return typeof value === 'string' && safeTransformPattern(value);
      if (node.operator === 'in' || node.operator === 'not_in')
        return (
          Array.isArray(value) &&
          value.length > 0 &&
          value.length <= TRANSFORM_LIMITS.tableRows &&
          value.every((item) => typeof item === 'string')
        );
      if (['lt', 'lte', 'gt', 'gte'].includes(node.operator))
        return typeof value === 'number' && Number.isFinite(value);
      return (
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      );
    };
    return valid(raw, 0) ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function conditionFields(node: MappingCondition): string[] {
  return [...new Set(node.kind === 'rule' ? [node.field] : node.children.flatMap(conditionFields))];
}

const blank = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0);
const text = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  )
    return String(value);
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return items.map(text).join(',');
  }
  // Inputs are bounded JSON values; match the console's ordinary object string coercion.
  return '[object Object]';
};

/** Only the supplied, rule-owned named inputs can be consulted. */
export function mappingConditionHolds(
  node: MappingCondition,
  inputs: ReadonlyMap<string, unknown>
): boolean {
  if (node.kind === 'group') {
    const results = node.children.map((child) => mappingConditionHolds(child, inputs));
    return node.match === 'all'
      ? results.every(Boolean)
      : node.match === 'any'
        ? results.some(Boolean)
        : !results.some(Boolean);
  }
  const actual = inputs.get(`field:${node.field}`);
  const expected = node.value;
  switch (node.operator) {
    case 'exists':
      return !blank(actual);
    case 'not_exists':
      return blank(actual);
    case 'eq':
      return text(actual) === text(expected);
    case 'ne':
      return text(actual) !== text(expected);
    case 'in':
      return Array.isArray(expected) && expected.includes(text(actual));
    case 'not_in':
      return Array.isArray(expected) && !expected.includes(text(actual));
    case 'contains':
      return Array.isArray(actual) && actual.map(text).includes(text(expected));
    case 'not_contains':
      return !(Array.isArray(actual) && actual.map(text).includes(text(expected)));
    case 'lt':
      return Number(text(actual).trim() || NaN) < Number(expected);
    case 'lte':
      return Number(text(actual).trim() || NaN) <= Number(expected);
    case 'gt':
      return Number(text(actual).trim() || NaN) > Number(expected);
    case 'gte':
      return Number(text(actual).trim() || NaN) >= Number(expected);
    case 'regex': {
      const value = text(actual);
      if (value.length > TRANSFORM_LIMITS.regexInputChars)
        failTransform('transform.limit_exceeded');
      return typeof expected === 'string' && new RegExp(expected, 'u').test(value);
    }
    default:
      return false;
  }
}

/** Charge every regex, including branches that do not decide the condition. */
export function conditionRegexWork(
  node: MappingCondition,
  inputs: ReadonlyMap<string, unknown>
): number {
  if (node.kind === 'group')
    return node.children.reduce((work, child) => work + conditionRegexWork(child, inputs), 0);
  if (node.operator !== 'regex' || typeof node.value !== 'string') return 0;
  const value = text(inputs.get(`field:${node.field}`));
  if (value.length > TRANSFORM_LIMITS.regexInputChars) failTransform('transform.limit_exceeded');
  return (value.length + 1) ** 2 * (node.value.length + 1);
}
