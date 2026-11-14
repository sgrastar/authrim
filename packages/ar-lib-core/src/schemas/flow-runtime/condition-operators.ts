/**
 * How a Flow condition compares what is known of a run (a user attribute, an age, the language)
 * with the values it names, when it names an `operator`. A condition without one compares as it
 * always has (equal to its value, or one of its values), so conditions saved before keep their
 * meaning.
 *
 * - `eq` / `in`: the value is one of the condition's values (a list matches when any of its items
 *   is). Nothing known never matches.
 * - `ne` / `not_in`: the opposite, so nothing known matches: a step shown to everyone who is not
 *   from a country is shown to someone whose country is not known (asking more is the safer way).
 * - `exists` / `not_exists`: whether anything is known (an empty text or list is nothing).
 * - `lt` / `lte` / `gt` / `gte`: numbers, or dates written `YYYY-MM-DD`, against the one value the
 *   condition names. Anything else (nothing known, a text, two kinds) never matches.
 */

export type FlowConditionOperator =
  | 'eq'
  | 'ne'
  | 'in'
  | 'not_in'
  | 'exists'
  | 'not_exists'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte';

export const FLOW_CONDITION_OPERATORS: ReadonlySet<FlowConditionOperator> = new Set([
  'eq',
  'ne',
  'in',
  'not_in',
  'exists',
  'not_exists',
  'lt',
  'lte',
  'gt',
  'gte',
]);

/** The operators that order values (numbers or dates). */
export const FLOW_CONDITION_ORDERING_OPERATORS: ReadonlySet<FlowConditionOperator> = new Set([
  'lt',
  'lte',
  'gt',
  'gte',
]);

/** What is known of a run for one condition: nothing, one value, or a list. */
export type FlowConditionOperand = string | number | boolean | readonly string[] | null | undefined;

type Scalar = string | number | boolean;

interface OperatorCondition {
  operator?: FlowConditionOperator;
  value?: Scalar;
  values?: Scalar[];
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const NUMBER = /^-?\d+(\.\d+)?$/u;

function known(actual: FlowConditionOperand): actual is Scalar | readonly string[] {
  if (actual === undefined || actual === null) return false;
  if (typeof actual === 'string') return actual.trim() !== '';
  if (Array.isArray(actual)) return actual.length > 0;
  return true;
}

function expected(condition: OperatorCondition): string[] {
  if (condition.values) return condition.values.map(String);
  return condition.value === undefined ? [] : [String(condition.value)];
}

function oneOf(actual: FlowConditionOperand, condition: OperatorCondition): boolean {
  if (!known(actual)) return false;
  const wanted = expected(condition);
  const items = Array.isArray(actual) ? actual.map(String) : [String(actual)];
  return items.some((item) => wanted.includes(item));
}

/** Whether a condition's value can be ordered: a finite number, a numeric text or a real date. */
export function isOrderableConditionValue(value: unknown): boolean {
  return orderable(value) !== null;
}

/** A number or a `YYYY-MM-DD` date, as something two of the same kind can be ordered by. */
function orderable(
  value: unknown
): { kind: 'number'; n: number } | { kind: 'date'; d: string } | null {
  if (typeof value === 'number')
    return Number.isFinite(value) ? { kind: 'number', n: value } : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (NUMBER.test(text)) return { kind: 'number', n: Number(text) };
  return validDate(text) ? { kind: 'date', d: text } : null;
}

function validDate(text: string): boolean {
  const match = DATE.exec(text);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function ordered(
  actual: FlowConditionOperand,
  condition: OperatorCondition,
  operator: FlowConditionOperator
): boolean {
  if (Array.isArray(actual) || condition.values) return false;
  const left = orderable(actual);
  const right = orderable(condition.value);
  if (!left || !right || left.kind !== right.kind) return false;
  const order =
    left.kind === 'number'
      ? Math.sign(left.n - (right as { n: number }).n)
      : left.d < (right as { d: string }).d
        ? -1
        : left.d > (right as { d: string }).d
          ? 1
          : 0;
  switch (operator) {
    case 'lt':
      return order < 0;
    case 'lte':
      return order <= 0;
    case 'gt':
      return order > 0;
    default:
      return order >= 0;
  }
}

/** Whether what is known matches a condition that names an operator. */
export function matchOperator(
  actual: FlowConditionOperand,
  condition: OperatorCondition & { operator: FlowConditionOperator }
): boolean {
  switch (condition.operator) {
    case 'eq':
    case 'in':
      return oneOf(actual, condition);
    case 'ne':
    case 'not_in':
      return !oneOf(actual, condition);
    case 'exists':
      return known(actual);
    case 'not_exists':
      return !known(actual);
    default:
      return ordered(actual, condition, condition.operator);
  }
}

/**
 * The age in whole years on the day `nowMs` falls on (UTC) of someone born on `birthdate`
 * (`YYYY-MM-DD`, as the OpenID Connect claim is written). Null when the date is not a full date
 * (`0000-MM-DD` or a year alone) or is after that day.
 */
export function ageOn(birthdate: unknown, nowMs: number): number | null {
  if (typeof birthdate !== 'string' || !validDate(birthdate.trim())) return null;
  const [year, month, day] = birthdate.trim().split('-').map(Number) as [number, number, number];
  const now = new Date(nowMs);
  const [y, m, d] = [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()];
  const age = y - year - (m < month || (m === month && d < day) ? 1 : 0);
  return age < 0 ? null : age;
}
