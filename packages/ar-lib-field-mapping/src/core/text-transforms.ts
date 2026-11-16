import { boundedReplace } from './text-replace';
import type { MappingTransformStep, ReasonCodeName } from './types';
import { TEXT_TRANSFORM_SCHEMAS } from './text-transform-schemas';
import { asciiDigits, stripAccents } from './text-fold';
import { toFullwidth, toHalfwidth } from './text-width';
import { dateFormat, textToNumber, validTimeZone } from './text-date';
import { failTransform, safeTransformPattern, TRANSFORM_LIMITS } from './transform-safety';

export const isTextTransform = (operation: string) =>
  TEXT_TRANSFORM_SCHEMAS.some((schema) => schema.operation === operation);

export function parseValueMap(text: unknown): [string, string][] | null {
  if (
    typeof text !== 'string' ||
    text.length > TRANSFORM_LIMITS.tableBytes ||
    new TextEncoder().encode(text).byteLength > TRANSFORM_LIMITS.tableBytes
  )
    return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length > TRANSFORM_LIMITS.tableRows) return null;
    const pairs: [string, string][] = [];
    for (const pair of parsed) {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        typeof pair[0] !== 'string' ||
        typeof pair[1] !== 'string'
      )
        return null;
      pairs.push([pair[0], pair[1]]);
    }
    return pairs;
  } catch {
    return null;
  }
}

/** Runs on save and again on load/execution, including settings hidden by the console. */
export function textSettingsProblem(step: MappingTransformStep): ReasonCodeName | null {
  const p = step.parameters ?? {};
  if (
    step.operation === 'regex_replace' &&
    (typeof p.pattern !== 'string' || !safeTransformPattern(p.pattern))
  )
    return 'transform.unsafe_regex';
  if (
    step.operation === 'filter_values' &&
    p.how === 'regex' &&
    (typeof p.match !== 'string' || !safeTransformPattern(p.match))
  )
    return 'transform.unsafe_regex';
  if (
    step.operation === 'value_map' &&
    (!parseValueMap(p.entries) || (p.otherwise === 'fixed' && typeof p.fallbackValue !== 'string'))
  )
    return 'transform.invalid_parameter';
  if (
    step.operation === 'normalize_empty' &&
    p.emptyAs === 'fixed' &&
    typeof p.emptyValue !== 'string'
  )
    return 'transform.missing_parameter';
  if (step.operation === 'date_format' && p.timeZone !== undefined && !validTimeZone(p.timeZone))
    return 'transform.invalid_parameter';
  return null;
}

const empty = (v: unknown) =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

export function executeTextTransform(step: MappingTransformStep, value: unknown): unknown {
  const p = step.parameters ?? {};
  const str = (key: string): string => (typeof p[key] === 'string' ? p[key] : '');
  const each = (fn: (item: unknown) => unknown) =>
    Array.isArray(value) ? value.map(fn) : fn(value);
  if (step.operation === 'has_value') return empty(value) === (p.invert === true);
  if (step.operation === 'default_if_empty') return empty(value) ? str('value') : value;
  if (step.operation === 'normalize_empty') {
    if (!empty(value) && !(p.spaces === true && typeof value === 'string' && /^\s*$/u.test(value)))
      return value;
    return p.emptyAs === 'empty' ? '' : p.emptyAs === 'fixed' ? str('emptyValue') : null;
  }
  if (step.operation === 'text_to_number') return each(textToNumber);
  if (step.operation === 'date_format') return each((item) => dateFormat(item, p));
  if (step.operation === 'filter_values') {
    const list = Array.isArray(value) ? value : empty(value) ? [] : [value];
    const match = str('match');
    const regex = p.how === 'regex' ? new RegExp(match, p.ignoreCase === true ? 'iu' : 'u') : null;
    return list.filter((item) => {
      if (typeof item !== 'string') return false;
      const a = p.ignoreCase === true ? item.toLowerCase() : item;
      const b = p.ignoreCase === true ? match.toLowerCase() : match;
      const hit = regex
        ? regex.test(item)
        : p.how === 'starts_with'
          ? a.startsWith(b)
          : p.how === 'ends_with'
            ? a.endsWith(b)
            : p.how === 'equals'
              ? a === b
              : a.includes(b);
      return hit !== (p.exclude === true);
    });
  }
  const pairs = step.operation === 'value_map' ? parseValueMap(p.entries) : null;
  return each((item) => {
    if (typeof item !== 'string') return item;
    switch (step.operation) {
      case 'keep_part': {
        const mark = str('delimiter');
        if (!mark) return item;
        const at = p.occurrence === 'last' ? item.lastIndexOf(mark) : item.indexOf(mark);
        return at < 0
          ? item
          : p.keep === 'after'
            ? item.slice(at + mark.length)
            : item.slice(0, at);
      }
      case 'remove_text':
        return str('text') ? item.split(str('text')).join('') : item;
      case 'replace_text': {
        const find = str('find');
        if (!find) return item;
        // A literal pattern has no repetition and cannot trigger backtracking.
        const literal = find.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        return boundedReplace(
          item,
          new RegExp(literal, p.ignoreCase === true ? 'giu' : 'gu'),
          str('replacement'),
          true
        );
      }
      case 'regex_replace':
        return boundedReplace(
          item,
          new RegExp(str('pattern'), p.ignoreCase === true ? 'giu' : 'gu'),
          str('replacement')
        );
      case 'to_halfwidth':
        return toHalfwidth(item, p.katakana === true);
      case 'to_fullwidth':
        return toFullwidth(item, p.katakana === true);
      case 'strip_accents':
        return stripAccents(item);
      case 'ascii_digits':
        return asciiDigits(item);
      case 'value_map': {
        const hit = pairs?.find(([from]) =>
          p.ignoreCase === true ? from.toLowerCase() === item.toLowerCase() : from === item
        );
        return hit
          ? hit[1]
          : p.otherwise === 'none'
            ? null
            : p.otherwise === 'fixed'
              ? str('fallbackValue')
              : item;
      }
      default:
        return failTransform('transform.unsupported_operation');
    }
  });
}
