/**
 * zod 3 compatible error output for zod 4 schemas.
 *
 * Admin API error bodies, plugin-config errors and setup CLI messages embed zod's
 * default issue messages (and, in a few setup responses, the raw issue objects).
 * zod 4 rewrote both ("Required" became "Invalid input: expected string, received
 * undefined", `invalid_string` became `invalid_format`, ...). These helpers reproduce
 * the zod 3 English messages and issue shapes so the responses stay identical.
 *
 * The module deliberately does not import zod (ar-lib-core has no zod dependency); it
 * reads issues structurally. Install it with
 * `z.config({ customError: legacyZodErrorMessage })` or per parse with
 * `schema.safeParse(input, { error: legacyZodErrorMessage })`.
 *
 * Only issues without an explicit schema message reach the error map, so
 * `z.string().min(1, 'custom')` keeps its own message.
 *
 * Differences this layer cannot hide (the input is rejected either way; only the
 * wording, the number of issues, or a boundary changes):
 * - zod 4 counts string length in code points, zod 3 in UTF-16 units, so strings with
 *   astral characters (emoji) cross `min`/`max`/`length` limits at different sizes.
 * - zod 4's `.int()` stops at a non-integer, so the range issue zod 3 added is gone.
 * - A record key that fails skips the value check, so zod 3's second (value) issue
 *   is gone.
 * - Length checks on a string schema also run on array input, so a string field given
 *   an array reports an extra "Array must contain ..." issue next to the type issue.
 * - An enum or literal with a schema-level custom message bypasses this map; a
 *   single-value enum then projects as a literal.
 */

/** The parts of a zod 4 (raw or finalized) issue the legacy formatting reads. */
export interface LegacyZodIssueSource {
  readonly code?: string;
  readonly message?: string;
  readonly path?: readonly PropertyKey[];
  readonly input?: unknown;
  readonly inst?: unknown;
  readonly expected?: string;
  readonly received?: string;
  readonly values?: readonly unknown[];
  readonly format?: string;
  readonly origin?: string;
  readonly minimum?: number | bigint;
  readonly maximum?: number | bigint;
  readonly inclusive?: boolean;
  readonly exact?: boolean;
  readonly keys?: readonly string[];
  readonly divisor?: number | bigint;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly includes?: string;
  readonly position?: number;
  readonly note?: string;
  readonly pattern?: string;
  readonly options?: readonly unknown[];
  readonly errors?: readonly (readonly LegacyZodIssueSource[])[];
  readonly issues?: readonly LegacyZodIssueSource[];
  readonly params?: Record<string, unknown>;
}

/** A zod 3 issue object as zod 3 serialized it. */
export type LegacyZodIssue = Record<string, unknown> & {
  code: string;
  path: PropertyKey[];
  message: string;
};

/** zod 3 `string().datetime()` without precision; `offset` adds `+09:00`/`+0900`/`+09`-less forms. */
const LEGACY_DATE_SOURCE =
  '((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))';
const LEGACY_TIME_SOURCE = '([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?';
const LEGACY_DATETIME = new RegExp(`^${LEGACY_DATE_SOURCE}T${LEGACY_TIME_SOURCE}(Z)$`);
const LEGACY_DATETIME_OFFSET = new RegExp(
  `^${LEGACY_DATE_SOURCE}T${LEGACY_TIME_SOURCE}(Z|([+-]\\d{2}:?\\d{2}))$`
);

/**
 * The regex zod 3 used for `z.string().datetime()` (seconds optional, any fraction).
 * zod 4's `z.iso.datetime()` requires seconds and a colon in offsets, so schemas that
 * must accept exactly what they accepted before use this with `.regex()`.
 */
export function legacyZodDatetimeRegex(options: { offset?: boolean } = {}): RegExp {
  return options.offset ? LEGACY_DATETIME_OFFSET : LEGACY_DATETIME;
}

/** The message zod 3 gave a failed `datetime()` check. */
export const LEGACY_ZOD_DATETIME_MESSAGE = 'Invalid datetime';

const FORMAT_VALIDATION: Record<string, string> = {
  email: 'email',
  url: 'url',
  uuid: 'uuid',
  guid: 'uuid',
  uuidv4: 'uuid',
  uuidv6: 'uuid',
  uuidv7: 'uuid',
  emoji: 'emoji',
  nanoid: 'nanoid',
  cuid: 'cuid',
  cuid2: 'cuid2',
  ulid: 'ulid',
  datetime: 'datetime',
  date: 'date',
  time: 'time',
  duration: 'duration',
  ipv4: 'ip',
  ipv6: 'ip',
  cidrv4: 'cidr',
  cidrv6: 'cidr',
  base64: 'base64',
  base64url: 'base64url',
  jwt: 'jwt',
  regex: 'regex',
};

const EXPECTED_TYPE: Record<string, string> = {
  int: 'integer',
  record: 'object',
  tuple: 'array',
};

/** zod 3 `util.joinValues`. */
function joinValues(values: readonly unknown[], separator = ' | '): string {
  return values
    .map((value) => (typeof value === 'string' ? `'${value}'` : String(value)))
    .join(separator);
}

function stringifyLiteral(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === 'bigint' ? entry.toString() : entry
  );
}

/** zod 3 `getParsedType`. */
export function legacyZodParsedType(data: unknown): string {
  switch (typeof data) {
    case 'undefined':
      return 'undefined';
    case 'string':
      return 'string';
    case 'number':
      return Number.isNaN(data) ? 'nan' : 'number';
    case 'boolean':
      return 'boolean';
    case 'function':
      return 'function';
    case 'bigint':
      return 'bigint';
    case 'symbol':
      return 'symbol';
    case 'object': {
      if (Array.isArray(data)) return 'array';
      if (data === null) return 'null';
      const candidate = data as { then?: unknown; catch?: unknown };
      if (typeof candidate.then === 'function' && typeof candidate.catch === 'function') {
        return 'promise';
      }
      if (data instanceof Map) return 'map';
      if (data instanceof Set) return 'set';
      if (data instanceof Date) return 'date';
      return 'object';
    }
    default:
      return 'unknown';
  }
}

function schemaType(inst: unknown): string | undefined {
  const internals = (inst as { _zod?: { def?: { type?: unknown } } } | undefined)?._zod;
  const type = internals?.def?.type;
  return typeof type === 'string' ? type : undefined;
}

type InvalidValueKind =
  | { kind: 'literal'; expected: unknown }
  | { kind: 'enum_type'; expected: string; received: string }
  | { kind: 'enum'; options: readonly unknown[] };

/**
 * Whether an `invalid_value` issue came from a literal. The error map sees the schema
 * instance; a finalized issue does not, but its message was written by the error map,
 * so the zod 3 wording tells literal and enum apart. Only a custom message on a
 * single-value schema falls back to guessing a literal.
 */
function isLiteralIssue(issue: LegacyZodIssueSource, values: readonly unknown[]): boolean {
  const type = schemaType(issue.inst);
  if (type) return type === 'literal';
  const message = issue.message;
  if (message?.startsWith('Invalid literal value, expected ')) return true;
  if (
    message !== undefined &&
    (message.startsWith('Invalid enum value. Expected ') ||
      message === 'Required' ||
      message.startsWith(`Expected ${joinValues(values)}, received `))
  ) {
    return false;
  }
  return values.length === 1;
}

/**
 * zod 4 reports literal and enum mismatches (and enums given a non-string) as
 * `invalid_value`; zod 3 had three distinct issues.
 */
function classifyInvalidValue(issue: LegacyZodIssueSource): InvalidValueKind {
  const values = issue.values ?? [];
  if (isLiteralIssue(issue, values)) {
    return { kind: 'literal', expected: values[0] };
  }
  const input = issue.input;
  const acceptsNumbers = values.some((value) => typeof value === 'number');
  const typeMatches = typeof input === 'string' || (acceptsNumbers && typeof input === 'number');
  if (!typeMatches && 'input' in issue) {
    return {
      kind: 'enum_type',
      expected: joinValues(values),
      received: legacyZodParsedType(input),
    };
  }
  return { kind: 'enum', options: values };
}

function legacyExpected(issue: LegacyZodIssueSource): string {
  const expected = issue.expected ?? 'unknown';
  return EXPECTED_TYPE[expected] ?? expected;
}

function legacyReceived(issue: LegacyZodIssueSource): string {
  if (issue.expected === 'int' && typeof issue.input === 'number') {
    return 'float';
  }
  return legacyZodParsedType(issue.input);
}

function sizeType(origin: string | undefined): string | undefined {
  if (origin === 'int') return 'number';
  return origin;
}

function tooSmallMessage(issue: LegacyZodIssueSource): string {
  const { exact, inclusive, minimum } = issue;
  switch (sizeType(issue.origin)) {
    case 'array':
      return `Array must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'more than'} ${String(minimum)} element(s)`;
    case 'string':
      return `String must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'over'} ${String(minimum)} character(s)`;
    case 'number':
    case 'bigint':
      return `Number must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${String(minimum)}`;
    case 'date':
      return `Date must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${String(new Date(Number(minimum)))}`;
    default:
      return 'Invalid input';
  }
}

function tooBigMessage(issue: LegacyZodIssueSource): string {
  const { exact, inclusive, maximum } = issue;
  switch (sizeType(issue.origin)) {
    case 'array':
      return `Array must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'less than'} ${String(maximum)} element(s)`;
    case 'string':
      return `String must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'under'} ${String(maximum)} character(s)`;
    case 'number':
      return `Number must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${String(maximum)}`;
    case 'bigint':
      return `BigInt must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${String(maximum)}`;
    case 'date':
      return `Date must be ${exact ? 'exactly' : inclusive ? 'smaller than or equal to' : 'smaller than'} ${String(new Date(Number(maximum)))}`;
    default:
      return 'Invalid input';
  }
}

function formatMessage(issue: LegacyZodIssueSource): string | undefined {
  switch (issue.format) {
    case 'starts_with':
      return `Invalid input: must start with "${issue.prefix ?? ''}"`;
    case 'ends_with':
      return `Invalid input: must end with "${issue.suffix ?? ''}"`;
    case 'includes': {
      const message = `Invalid input: must include "${issue.includes ?? ''}"`;
      return typeof issue.position === 'number'
        ? `${message} at one or more positions greater than or equal to ${issue.position}`
        : message;
    }
    default: {
      const validation = issue.format ? FORMAT_VALIDATION[issue.format] : undefined;
      if (!validation) return undefined;
      return validation === 'regex' ? 'Invalid' : `Invalid ${validation}`;
    }
  }
}

function isDiscriminatorIssue(issue: LegacyZodIssueSource): boolean {
  return issue.code === 'invalid_union' && Array.isArray(issue.options) && issue.note !== undefined;
}

/**
 * The zod 3 English message for a zod 4 issue, or `undefined` to fall back to zod's
 * own message (for issue kinds zod 3 did not have).
 */
export function legacyZodErrorMessage(issue: LegacyZodIssueSource): string | undefined {
  switch (issue.code) {
    case 'invalid_type': {
      if (issue.received === 'Invalid Date') return 'Invalid date';
      if (issue.input === undefined) return 'Required';
      if (
        issue.expected === 'number' &&
        typeof issue.input === 'number' &&
        !Number.isNaN(issue.input)
      ) {
        // zod 4 rejects ±Infinity in z.number(); zod 3 only did so with .finite().
        return 'Number must be finite';
      }
      return `Expected ${legacyExpected(issue)}, received ${legacyReceived(issue)}`;
    }
    case 'invalid_value': {
      const kind = classifyInvalidValue(issue);
      if (kind.kind === 'literal') {
        return `Invalid literal value, expected ${stringifyLiteral(kind.expected)}`;
      }
      if (kind.kind === 'enum_type') {
        return issue.input === undefined
          ? 'Required'
          : `Expected ${kind.expected}, received ${kind.received}`;
      }
      return `Invalid enum value. Expected ${joinValues(kind.options)}, received '${String(issue.input)}'`;
    }
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${joinValues(issue.keys ?? [], ', ')}`;
    case 'invalid_union':
      return isDiscriminatorIssue(issue)
        ? `Invalid discriminator value. Expected ${joinValues(issue.options ?? [])}`
        : 'Invalid input';
    case 'invalid_format':
      return formatMessage(issue);
    case 'too_small':
      return tooSmallMessage(issue);
    case 'too_big':
      return tooBigMessage(issue);
    case 'not_multiple_of':
      return `Number must be a multiple of ${String(issue.divisor)}`;
    case 'invalid_key':
      // zod 3 reported each key issue on its own; joined, they read the same in the
      // `issues.map((i) => i.message).join(', ')` bodies.
      return issue.issues
        ?.map((nested) => nested.message ?? legacyZodErrorMessage(nested))
        .filter((message): message is string => message !== undefined)
        .join(', ');
    case 'custom':
      return 'Invalid input';
    default:
      return undefined;
  }
}

function legacyValidation(issue: LegacyZodIssueSource): unknown {
  switch (issue.format) {
    case 'starts_with':
      return { startsWith: issue.prefix };
    case 'ends_with':
      return { endsWith: issue.suffix };
    case 'includes':
      return typeof issue.position === 'number'
        ? { includes: issue.includes, position: issue.position }
        : { includes: issue.includes };
    case 'regex':
      // legacyZodDatetimeRegex() stands in for zod 3's datetime() check.
      return issue.pattern === String(LEGACY_DATETIME) ||
        issue.pattern === String(LEGACY_DATETIME_OFFSET)
        ? 'datetime'
        : 'regex';
    default:
      return (issue.format && FORMAT_VALIDATION[issue.format]) ?? issue.format;
  }
}

/**
 * Project a finalized zod 4 issue onto the object zod 3 produced for the same
 * failure. Parse with `{ reportInput: true }` so `received` can be reconstructed;
 * the `input` itself is not copied into the result.
 */
export function toLegacyZodIssue(issue: LegacyZodIssueSource): LegacyZodIssue {
  const base = {
    path: [...(issue.path ?? [])],
    message: issue.message ?? legacyZodErrorMessage(issue) ?? 'Invalid input',
  };
  switch (issue.code) {
    case 'invalid_type':
      if (issue.received === 'Invalid Date') {
        return { code: 'invalid_date', ...base };
      }
      return {
        code: 'invalid_type',
        expected: legacyExpected(issue),
        received: legacyReceived(issue),
        ...base,
      };
    case 'invalid_value': {
      const kind = classifyInvalidValue(issue);
      if (kind.kind === 'literal') {
        return { code: 'invalid_literal', expected: kind.expected, received: issue.input, ...base };
      }
      if (kind.kind === 'enum_type') {
        return { code: 'invalid_type', expected: kind.expected, received: kind.received, ...base };
      }
      return {
        code: 'invalid_enum_value',
        options: [...kind.options],
        received: issue.input,
        ...base,
      };
    }
    case 'invalid_format':
      return { code: 'invalid_string', validation: legacyValidation(issue), ...base };
    case 'too_small':
      return {
        code: 'too_small',
        minimum: issue.minimum,
        type: sizeType(issue.origin),
        inclusive: issue.inclusive ?? true,
        exact: issue.exact ?? false,
        ...base,
      };
    case 'too_big':
      return {
        code: 'too_big',
        maximum: issue.maximum,
        type: sizeType(issue.origin),
        inclusive: issue.inclusive ?? true,
        exact: issue.exact ?? false,
        ...base,
      };
    case 'unrecognized_keys':
      return { code: 'unrecognized_keys', keys: [...(issue.keys ?? [])], ...base };
    case 'invalid_union':
      if (isDiscriminatorIssue(issue)) {
        return {
          code: 'invalid_union_discriminator',
          options: [...(issue.options ?? [])],
          ...base,
        };
      }
      return {
        code: 'invalid_union',
        unionErrors: (issue.errors ?? []).map((issues) => ({
          // zod 4 keeps branch paths relative to their union; zod 3 used full input paths.
          issues: toLegacyZodIssues(
            issues.map((nested) => ({
              ...nested,
              path: [...base.path, ...(nested.path ?? [])],
            }))
          ),
          name: 'ZodError',
        })),
        ...base,
      };
    case 'not_multiple_of':
      return { code: 'not_multiple_of', multipleOf: issue.divisor, ...base };
    case 'custom':
      return issue.params
        ? { code: 'custom', params: issue.params, ...base }
        : { code: 'custom', ...base };
    default:
      return { code: issue.code ?? 'custom', ...base };
  }
}

/**
 * Project a list of finalized zod 4 issues onto zod 3 issue objects. zod 4 wraps
 * record-key failures in one `invalid_key` issue; zod 3 reported each key issue
 * directly at the key's path, so those are unwrapped here.
 */
export function toLegacyZodIssues(issues: readonly LegacyZodIssueSource[]): LegacyZodIssue[] {
  return issues.flatMap((issue) => {
    if (issue.code !== 'invalid_key' || !issue.issues?.length) {
      return [toLegacyZodIssue(issue)];
    }
    const keyPath = issue.path ?? [];
    return toLegacyZodIssues(
      issue.issues.map((nested) => ({ ...nested, path: [...keyPath, ...(nested.path ?? [])] }))
    );
  });
}

/**
 * The zod 3 issue code for a zod 4 issue (`invalid_format` → `invalid_string`, ...),
 * for APIs that expose the code next to the message.
 */
export function legacyZodIssueCode(issue: LegacyZodIssueSource): string {
  return toLegacyZodIssue(issue).code;
}
