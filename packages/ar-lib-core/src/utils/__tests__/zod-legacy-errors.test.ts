import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { z as z3 } from 'zod/v3';
import {
  LEGACY_ZOD_DATETIME_MESSAGE,
  legacyZodDatetimeRegex,
  legacyZodErrorMessage,
  legacyZodIssueCode,
  toLegacyZodIssue,
  toLegacyZodIssues,
} from '../zod-legacy-errors';

/**
 * Differential cases: the same schema built with zod 3 (`zod/v3`, the legacy
 * implementation zod 4 still ships) and with zod 4 must report the same messages and
 * issue objects once the legacy error map is installed.
 */
type Case = [
  name: string,
  v3: (zod: typeof z3) => z3.ZodTypeAny,
  v4: (zod: typeof z) => z.ZodType,
  input: unknown,
];

const CASES: Case[] = [
  ['missing string', (q) => q.object({ a: q.string() }), (q) => q.object({ a: q.string() }), {}],
  ['wrong type', (q) => q.object({ a: q.string() }), (q) => q.object({ a: q.string() }), { a: 1 }],
  ['null root', (q) => q.object({ a: q.string() }), (q) => q.object({ a: q.string() }), null],
  ['array root', (q) => q.object({}), (q) => q.object({}), []],
  ['email', (q) => q.string().email(), (q) => q.email(), 'x'],
  ['url', (q) => q.string().url(), (q) => q.url(), 'x'],
  ['uuid', (q) => q.string().uuid(), (q) => q.guid(), 'x'],
  ['min string', (q) => q.string().min(3), (q) => q.string().min(3), 'x'],
  ['max string', (q) => q.string().max(1), (q) => q.string().max(1), 'xx'],
  ['length', (q) => q.string().length(2), (q) => q.string().length(2), 'x'],
  ['min number', (q) => q.number().min(3), (q) => q.number().min(3), 1],
  ['max number', (q) => q.number().max(3), (q) => q.number().max(3), 5],
  ['positive', (q) => q.number().positive(), (q) => q.number().positive(), 0],
  ['lt', (q) => q.number().lt(3), (q) => q.number().lt(3), 3],
  ['int', (q) => q.number().int(), (q) => q.number().int(), 1.5],
  ['int wrong type', (q) => q.number().int(), (q) => q.number().int(), 'x'],
  [
    'nonnegative int',
    (q) => q.number().int().nonnegative(),
    (q) => q.number().int().nonnegative(),
    -1,
  ],
  ['multipleOf', (q) => q.number().multipleOf(2), (q) => q.number().multipleOf(2), 3],
  ['coerce NaN', (q) => q.coerce.number().int(), (q) => q.coerce.number().int(), 'abc'],
  ['enum', (q) => q.enum(['a', 'b']), (q) => q.enum(['a', 'b']), 'c'],
  ['enum non-string', (q) => q.enum(['a', 'b']), (q) => q.enum(['a', 'b']), 1],
  [
    'enum missing',
    (q) => q.object({ e: q.enum(['a', 'b']) }),
    (q) => q.object({ e: q.enum(['a', 'b']) }),
    {},
  ],
  ['literal', (q) => q.literal('a'), (q) => q.literal('a'), 'b'],
  [
    'literal missing',
    (q) => q.object({ l: q.literal(1) }),
    (q) => q.object({ l: q.literal(1) }),
    {},
  ],
  ['strict', (q) => q.object({}).strict(), (q) => q.strictObject({}), { x: 1, y: 2 }],
  ['regex', (q) => q.string().regex(/^a$/), (q) => q.string().regex(/^a$/), 'b'],
  ['startsWith', (q) => q.string().startsWith('a'), (q) => q.string().startsWith('a'), 'b'],
  ['endsWith', (q) => q.string().endsWith('a'), (q) => q.string().endsWith('a'), 'b'],
  ['includes', (q) => q.string().includes('a'), (q) => q.string().includes('a'), 'b'],
  ['array min', (q) => q.array(q.string()).min(1), (q) => q.array(q.string()).min(1), []],
  ['array max', (q) => q.array(q.string()).max(1), (q) => q.array(q.string()).max(1), ['a', 'b']],
  ['array type', (q) => q.array(q.number()), (q) => q.array(q.number()), 'x'],
  [
    'record value',
    (q) => q.record(q.number()),
    (q) => q.record(q.string(), q.number()),
    { a: 'x' },
  ],
  ['record root', (q) => q.record(q.number()), (q) => q.record(q.string(), q.number()), 'x'],
  [
    'discriminator',
    (q) =>
      q.discriminatedUnion('t', [q.object({ t: q.literal('a') }), q.object({ t: q.literal('b') })]),
    (q) =>
      q.discriminatedUnion('t', [q.object({ t: q.literal('a') }), q.object({ t: q.literal('b') })]),
    { t: 'c' },
  ],
  [
    'discriminator missing',
    (q) =>
      q.discriminatedUnion('t', [q.object({ t: q.literal('a') }), q.object({ t: q.literal('b') })]),
    (q) =>
      q.discriminatedUnion('t', [q.object({ t: q.literal('a') }), q.object({ t: q.literal('b') })]),
    {},
  ],
  ['boolean', (q) => q.boolean(), (q) => q.boolean(), 'x'],
  ['refine', (q) => q.string().refine(() => false), (q) => q.string().refine(() => false), 'x'],
  [
    'refine message',
    (q) => q.string().refine(() => false, { message: 'nope' }),
    (q) => q.string().refine(() => false, { error: 'nope' }),
    'x',
  ],
  [
    'schema message',
    (q) => q.string().min(2, 'too short'),
    (q) => q.string().min(2, 'too short'),
    'x',
  ],
  [
    'superRefine custom',
    (q) =>
      q
        .string()
        .superRefine((_v, ctx) => ctx.addIssue({ code: q.ZodIssueCode.custom, message: 'bad' })),
    (q) => q.string().superRefine((_v, ctx) => ctx.addIssue({ code: 'custom', message: 'bad' })),
    'x',
  ],
  [
    'nested multi',
    (q) =>
      q.object({
        a: q.string().min(1),
        b: q.array(q.object({ c: q.number().int().max(5) })),
        d: q.enum(['x', 'y']).optional(),
      }),
    (q) =>
      q.object({
        a: q.string().min(1),
        b: q.array(q.object({ c: q.number().int().max(5) })),
        d: q.enum(['x', 'y']).optional(),
      }),
    { a: '', b: [{ c: 9 }, { c: 'x' }, {}], d: 'z' },
  ],
];

describe('legacy zod error output', () => {
  it.each(CASES)('matches zod 3 for %s', (_name, v3, v4, input) => {
    const legacy = v3(z3).safeParse(input);
    const modern = v4(z).safeParse(input, { error: legacyZodErrorMessage, reportInput: true });
    expect(legacy.success).toBe(false);
    expect(modern.success).toBe(false);
    if (legacy.success || modern.success) return;

    const expected = JSON.parse(JSON.stringify(legacy.error.issues)) as unknown[];
    const actual = JSON.parse(
      JSON.stringify(modern.error.issues.map(toLegacyZodIssue))
    ) as unknown[];
    expect(actual).toEqual(expected);
    expect(modern.error.issues.map((issue) => issue.message)).toEqual(
      legacy.error.issues.map((issue) => issue.message)
    );
  });

  it('works as the global custom error map', () => {
    const previous = z.config().customError;
    z.config({ customError: legacyZodErrorMessage });
    try {
      const result = z.object({ a: z.string() }).safeParse({});
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Required');
      }
    } finally {
      z.config({ customError: previous });
    }
  });

  it('maps codes without the input for finalized issues', () => {
    const result = z
      .object({ e: z.enum(['a', 'b']), l: z.literal('x'), m: z.email() })
      .safeParse({ e: 'c', l: 'y', m: 'z' }, { error: legacyZodErrorMessage });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map(legacyZodIssueCode)).toEqual([
        'invalid_enum_value',
        'invalid_literal',
        'invalid_string',
      ]);
    }
  });

  it('documents that zod 4 stops at a non-integer before range checks', () => {
    // zod 3 reported both issues; zod 4's int check never continues. The input is
    // rejected either way, only the second message is gone.
    const legacy = z3.number().int().nonnegative().safeParse(-1.5);
    const modern = z.number().int().nonnegative().safeParse(-1.5, { error: legacyZodErrorMessage });
    expect(legacy.success || modern.success).toBe(false);
    if (!legacy.success && !modern.success) {
      expect(legacy.error.issues.map((issue) => issue.message)).toEqual([
        'Expected integer, received float',
        'Number must be greater than or equal to 0',
      ]);
      expect(modern.error.issues.map((issue) => issue.message)).toEqual([
        'Expected integer, received float',
      ]);
    }
  });

  it.each([
    ['missing', {}],
    ['wrong value', { e: 'b' }],
    ['wrong type', { e: 1 }],
  ])('projects a single-value enum like zod 3 (%s)', (_name, input) => {
    const legacy = z3.object({ e: z3.enum(['a']) }).safeParse(input);
    const modern = z
      .object({ e: z.enum(['a']) })
      .safeParse(input, { error: legacyZodErrorMessage, reportInput: true });
    expect(legacy.success || modern.success).toBe(false);
    if (!legacy.success && !modern.success) {
      expect(JSON.parse(JSON.stringify(modern.error.issues.map(toLegacyZodIssue)))).toEqual(
        JSON.parse(JSON.stringify(legacy.error.issues))
      );
    }
  });

  it('unwraps record-key issues to the key path like zod 3', () => {
    const v3Schema = z3.object({
      h: z3.record(
        z3
          .string()
          .regex(/^[A-Z]+$/)
          .min(3),
        z3.string()
      ),
    });
    const v4Schema = z.object({
      h: z.record(
        z
          .string()
          .regex(/^[A-Z]+$/)
          .min(3),
        z.string()
      ),
    });
    const input = { h: { 'b-k': 'v', OK: 'v', GOOD: 'v' } };
    const legacy = v3Schema.safeParse(input);
    const modern = v4Schema.safeParse(input, { error: legacyZodErrorMessage, reportInput: true });
    expect(legacy.success || modern.success).toBe(false);
    if (!legacy.success && !modern.success) {
      expect(JSON.parse(JSON.stringify(toLegacyZodIssues(modern.error.issues)))).toEqual(
        JSON.parse(JSON.stringify(legacy.error.issues))
      );
      expect(modern.error.issues.map((issue) => issue.message).join(', ')).toBe(
        legacy.error.issues.map((issue) => issue.message).join(', ')
      );
    }
  });

  it('documents that zod 4 measures string lengths in code points', () => {
    // zod 3 counted UTF-16 units. Only strings with astral characters (emoji, ...) differ:
    // a max(N) limit admits up to 2N units and a min(N) floor needs N code points.
    const emoji = '\u{1F600}';
    expect(z3.string().max(3).safeParse(emoji.repeat(3)).success).toBe(false);
    expect(z.string().max(3).safeParse(emoji.repeat(3)).success).toBe(true);
    expect(z3.string().min(3).safeParse(emoji.repeat(2)).success).toBe(true);
    expect(z.string().min(3).safeParse(emoji.repeat(2)).success).toBe(false);
  });

  it('reports non-finite numbers with the zod 3 finite() message', () => {
    const result = z.number().safeParse(Infinity, { error: legacyZodErrorMessage });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Number must be finite');
    }
  });

  it.each([
    ['2026-01-01T10:00Z', false, true],
    ['2026-01-01T10:00:00Z', false, true],
    ['2026-01-01T10:00:00.123456Z', false, true],
    ['2026-01-01T10:00:00+09:00', false, false],
    ['2026-01-01T10:00:00+09:00', true, true],
    ['2026-01-01T10:00:00+0900', true, true],
    ['2026-01-01T10:00+99:99', true, true],
    ['2026-02-30T10:00:00Z', false, false],
    ['2026-01-01', false, false],
    ['2026-01-01T24:00:00Z', false, false],
  ])('keeps the zod 3 datetime acceptance for %s (offset %s)', (value, offset, accepted) => {
    const legacy = (
      offset ? z3.string().datetime({ offset: true }) : z3.string().datetime()
    ).safeParse(value);
    expect(legacy.success).toBe(accepted);
    const modern = z
      .string()
      .regex(legacyZodDatetimeRegex({ offset }), { error: LEGACY_ZOD_DATETIME_MESSAGE })
      .safeParse(value);
    expect(modern.success).toBe(accepted);
    if (!modern.success && !legacy.success) {
      expect(modern.error.issues[0].message).toBe(legacy.error.issues[0].message);
    }
  });

  it.each([
    'a@example.com',
    'a.b+c@sub.example.co',
    "o'brien@example.com",
    '.a@example.com',
    'a..b@example.com',
    'a.@example.com',
    'a@example',
    'a@-example.com',
    'a@example.c',
    'A_B-C@EXAMPLE.COM',
    'a@ex_ample.com',
    'ünï@example.com',
    'a@@example.com',
    '',
  ])('accepts the same emails as zod 3: %s', (value) => {
    expect(z.email().safeParse(value).success).toBe(z3.string().email().safeParse(value).success);
  });

  it.each([
    '11111111-1111-1111-1111-111111111111',
    '00000000-0000-0000-0000-00000000000a',
    'ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB',
    '11111111-1111-4111-8111-11111111111',
    'g1111111-1111-1111-1111-111111111111',
  ])('accepts the same uuids as zod 3 via z.guid(): %s', (value) => {
    expect(z.guid().safeParse(value).success).toBe(z3.string().uuid().safeParse(value).success);
  });

  it.each([
    'https://example.com',
    'http://localhost:8080/path?q=1',
    'mailto:a@example.com',
    'custom:thing',
    'not a url',
    '//example.com',
    ' https://example.com ',
    'https://exa mple.com',
  ])('accepts the same urls as zod 3: %s', (value) => {
    expect(z.url().safeParse(value).success).toBe(z3.string().url().safeParse(value).success);
  });
});
