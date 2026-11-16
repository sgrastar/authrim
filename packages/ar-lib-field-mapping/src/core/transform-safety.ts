import type { MappingTransformStep, ReasonCodeName, SourceValueEnvelope } from './types';

/** Shared by every operation, preview and graph evaluation. Units bound scanning/allocation work. */
export const TRANSFORM_LIMITS = Object.freeze({
  valueBytes: 32 * 1024,
  keyBytes: 4 * 1024,
  arrayItems: 500,
  nodes: 1000,
  depth: 12,
  tableRows: 256,
  tableBytes: 16 * 1024,
  patternChars: 512,
  regexInputChars: 1024,
  ruleWork: 8 * 1024 * 1024,
});

export class TransformFailure extends Error {
  constructor(readonly code: ReasonCodeName) {
    super(code);
  }
}

export function failTransform(code: ReasonCodeName): never {
  throw new TransformFailure(code);
}

/** Count UTF-8 payload plus JSON framing, without serializing unbounded/cyclic objects. */
export function measureTransformValue(value: unknown): number {
  let bytes = 0;
  let nodes = 0;
  const seen = new WeakSet<object>();
  const encoder = new TextEncoder();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > TRANSFORM_LIMITS.nodes || depth > TRANSFORM_LIMITS.depth)
      failTransform('transform.limit_exceeded');
    if (typeof item === 'string') {
      if (item.length > TRANSFORM_LIMITS.valueBytes) failTransform('transform.limit_exceeded');
      bytes += encoder.encode(item).byteLength + 2;
    } else if (item !== null && typeof item === 'object') {
      if (seen.has(item)) failTransform('transform.limit_exceeded');
      seen.add(item);
      const entries = Array.isArray(item) ? item : Object.entries(item);
      if (entries.length > TRANSFORM_LIMITS.arrayItems) failTransform('transform.limit_exceeded');
      bytes += 2 + entries.length;
      for (const child of entries) visit(child, depth + 1);
      seen.delete(item);
    } else {
      bytes += typeof item === 'number' ? String(item).length : 8;
    }
    if (bytes > TRANSFORM_LIMITS.valueBytes) failTransform('transform.limit_exceeded');
  };
  visit(value, 0);
  return bytes;
}

/**
 * Deliberately small JS-regex subset: no backreferences, lookaround, special groups, alternation
 * inside groups, quantified groups, or more than one variable repetition in the entire pattern.
 * Plain captures, classes, anchors and top-level alternatives remain available. Fixed repetition
 * is also disallowed: it could multiply the work of the variable repetition. With only one
 * repeated single atom there is no combinatorial backtracking. Unanchored searches can still
 * be quadratic; the 1024-character input cap and quadratic work charge bound that case.
 */
export function safeTransformPattern(pattern: string): boolean {
  if (!pattern || pattern.length > TRANSFORM_LIMITS.patternChars) return false;
  let inClass = false;
  let groups = 0;
  let repetitions = 0;
  let atom = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') {
      const next = pattern[++i];
      if (!next || /[0-9kpP]/u.test(next)) return false;
      // Unicode and hex escapes must not conceal metacharacters from this scanner.
      if (next === 'u' || next === 'x' || next === 'c') return false;
      atom = true;
      continue;
    }
    if (inClass) {
      if (c === ']') {
        inClass = false;
        atom = true;
      }
      continue;
    }
    if (c === '[') {
      inClass = true;
      atom = false;
      continue;
    }
    if (c === '(') {
      if (pattern[i + 1] === '?') return false;
      groups++;
      atom = false;
    } else if (c === ')') {
      if (--groups < 0) return false;
      atom = false; // A group may never be quantified.
    } else if (c === '|') {
      if (groups) return false;
      atom = false;
    } else if (c === '{' || c === '}') {
      return false;
    } else if (c === '*' || c === '+' || c === '?') {
      if (!atom || ++repetitions > 1) return false;
      atom = false;
    } else {
      atom = c !== '^' && c !== '$';
    }
  }
  if (inClass || groups) return false;
  try {
    new RegExp(pattern, 'u');
    return true;
  } catch {
    return false;
  }
}

export function safeRegexTest(pattern: string, value: string, ignoreCase = false): boolean {
  return value.length <= TRANSFORM_LIMITS.regexInputChars && safeTransformPattern(pattern)
    ? new RegExp(pattern, ignoreCase ? 'iu' : 'u').test(value)
    : false;
}

export function transformWork(step: MappingTransformStep, value: unknown, bytes: number): number {
  const p = step.parameters ?? {};
  const pattern =
    step.operation === 'regex_replace'
      ? p.pattern
      : step.operation === 'filter_values' && p.how === 'regex'
        ? p.match
        : undefined;
  const items = Array.isArray(value) ? value : [value];
  const baseWork = (bytes + 1) * (measureTransformValue(p) + 1);
  if (typeof pattern === 'string') {
    let work = 0;
    for (const item of items) {
      if (typeof item !== 'string') continue;
      if (item.length > TRANSFORM_LIMITS.regexInputChars) failTransform('transform.limit_exceeded');
      work += (item.length + 1) ** 2 * (pattern.length + 1);
    }
    return baseWork + work;
  }
  // Includes replacement growth, table lookup, normalization and list scanning.
  return baseWork;
}

/** Every source string consulted for json_build key lookup or fallback key shaping. */
export function jsonBuildSourceKeys(source: SourceValueEnvelope): unknown[] {
  return [
    source.sourceRef.catalogEntryId,
    source.metadata?.columnName,
    source.metadata?.csvHeaderName,
    source.metadata?.fieldPath,
    source.sourceRef.path,
  ];
}

function jsonBuildKeyBytes(sources: readonly SourceValueEnvelope[]): number {
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const source of sources) {
    for (const key of jsonBuildSourceKeys(source)) {
      if (typeof key !== 'string') continue;
      if (key.length > TRANSFORM_LIMITS.keyBytes) failTransform('transform.limit_exceeded');
      const length = encoder.encode(key).byteLength;
      if (length > TRANSFORM_LIMITS.keyBytes) failTransform('transform.limit_exceeded');
      bytes += length + 2;
      if (bytes > TRANSFORM_LIMITS.valueBytes) failTransform('transform.limit_exceeded');
    }
  }
  return bytes;
}

/** Shared charging path for synchronous operations and caller-prepared values. */
export function chargeTransformInput(
  step: MappingTransformStep,
  values: unknown[],
  budget: { remaining: number },
  sources: readonly SourceValueEnvelope[] = []
): void {
  const bytes =
    measureTransformValue(values) +
    (step.operation === 'json_build' ? jsonBuildKeyBytes(sources) : 0);
  if (bytes > TRANSFORM_LIMITS.valueBytes) failTransform('transform.limit_exceeded');
  const work = transformWork(step, values.length === 1 ? values[0] : values, bytes);
  if (work > budget.remaining) failTransform('transform.work_limit_exceeded');
  budget.remaining -= work;
}

export function chargeTransformOutput(value: unknown, budget: { remaining: number }): void {
  const bytes = measureTransformValue(value);
  if (bytes > budget.remaining) failTransform('transform.work_limit_exceeded');
  budget.remaining -= bytes;
}
