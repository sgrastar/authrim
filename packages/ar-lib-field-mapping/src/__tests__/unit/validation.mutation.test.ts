import { describe, expect, it } from 'vitest';
import { sameFieldRef, validateMappingInput } from '../../core/validation';
import type {
  FieldCatalogBundle,
  FieldCatalogEntry,
  FieldRef,
  MappingInput,
  MappingRuleGraph,
  MappingTransformStep,
  ReasonCode,
  ReasonSeverity,
  ValidationRule,
  ValidationRuleKind,
} from '../../core/types';
import { TEST_CATALOG, edge, fieldRef, mappingInput, sourceValue } from '../../test-support';

const emailSource: FieldRef = { side: 'source', namespace: 'csv', path: 'email' };
const canonicalEmail: FieldRef = {
  side: 'canonical',
  namespace: 'authrim.profile',
  path: 'email',
  catalogEntryId: 'field.canonical.email',
};
const unknownRef: FieldRef = { side: 'source', namespace: 'csv', path: 'does-not-exist' };

const invalidEntry: ReasonCode = {
  category: 'catalog',
  code: 'catalog.invalid_entry',
  severity: 'error',
};

function rule(
  kind: ValidationRuleKind,
  parameters?: Record<string, unknown>,
  defaultSeverity?: ReasonSeverity,
  targetRef: FieldRef = emailSource
): ValidationRule {
  return { id: `rule.${kind}`, kind, targetRef, parameters, defaultSeverity };
}

const LAX_ENTRY: FieldCatalogEntry = {
  id: 'field.csv.email',
  namespace: 'csv',
  path: 'email',
  valueType: 'any',
  cardinality: 'multi',
  classification: 'pii',
};
const LAX_CATALOG: FieldCatalogBundle = { ...TEST_CATALOG, entries: [LAX_ENTRY] };

/** The catalog accepts any value, so only the rules under test can report. */
function validateValue(value: unknown, rules: ValidationRule[]) {
  const input: MappingInput = {
    catalog: LAX_CATALOG,
    sourceValues: [sourceValue('csv', 'email', value)],
    edges: [],
  };
  return validateMappingInput({ ...input, validationRules: rules });
}

function codes(result: { reasons: ReasonCode[] }) {
  return result.reasons.map((item) => `${item.code}:${item.severity}`);
}

describe('catalog reasons and entry lookups', () => {
  it('starts with the catalog bundle reasons', () => {
    const catalog: FieldCatalogBundle = {
      ...TEST_CATALOG,
      entries: [{ ...LAX_ENTRY, id: '' }],
    };
    const result = validateMappingInput({ catalog, sourceValues: [], edges: [] });
    expect(result.reasons).toEqual([invalidEntry]);
    expect(result.status).toBe('partial');
  });

  it('is successful for a consistent input', () => {
    const result = validateMappingInput(mappingInput([sourceValue('csv', 'email', 'a@b.test')]));
    expect(result).toEqual({ status: 'success', reasons: [], trace: [] });
  });

  it('reports a graph rule whose target is not in the catalog', () => {
    const graphRule: MappingRuleGraph = {
      id: 'g',
      targetRef: unknownRef,
      edges: [edge(emailSource, canonicalEmail)],
      transforms: [],
      output: { edgeIndex: 0 },
    };
    const input: MappingInput = { ...mappingInput([]), edges: [], graphRules: [graphRule] };
    expect(validateMappingInput(input).reasons).toEqual([invalidEntry]);
  });

  it('reports each graph rule edge whose source is not in the catalog', () => {
    const graphRule: MappingRuleGraph = {
      id: 'g',
      targetRef: canonicalEmail,
      edges: [
        edge(unknownRef, canonicalEmail),
        edge(emailSource, canonicalEmail),
        edge(unknownRef, canonicalEmail),
      ],
      transforms: [],
      output: { edgeIndex: 1 },
    };
    const input: MappingInput = { ...mappingInput([]), edges: [], graphRules: [graphRule] };
    expect(validateMappingInput(input).reasons).toEqual([invalidEntry, invalidEntry]);
  });

  it('accepts graph rules that resolve in the catalog', () => {
    const graphRule: MappingRuleGraph = {
      id: 'g',
      targetRef: canonicalEmail,
      edges: [edge(emailSource, canonicalEmail)],
      transforms: [],
      output: { edgeIndex: 0 },
    };
    const input: MappingInput = { ...mappingInput([]), edges: [], graphRules: [graphRule] };
    expect(validateMappingInput(input).reasons).toEqual([]);
  });

  it('reports edge sources and targets that are missing from the catalog separately', () => {
    const base = mappingInput([]);
    expect(
      validateMappingInput({ ...base, edges: [edge(unknownRef, canonicalEmail)] }).reasons
    ).toEqual([invalidEntry]);
    expect(
      validateMappingInput({ ...base, edges: [edge(emailSource, unknownRef)] }).reasons
    ).toEqual([invalidEntry]);
    expect(
      validateMappingInput({
        ...base,
        edges: [edge(unknownRef, { ...unknownRef, side: 'canonical' })],
      }).reasons
    ).toEqual([invalidEntry, invalidEntry]);
  });

  it('reports source values missing from the catalog and skips their type checks', () => {
    const result = validateMappingInput(
      mappingInput([sourceValue('csv', 'does-not-exist', 123), sourceValue('csv', 'email', 5)])
    );
    expect(codes(result)).toEqual([
      'catalog.invalid_entry:error',
      'validation.type_mismatch:error',
    ]);
    expect(result.status).toBe('partial');
  });

  it('checks the catalog cardinality and value type of source values', () => {
    expect(
      codes(validateMappingInput(mappingInput([sourceValue('csv', 'email', ['a', 'b'])])))
    ).toEqual(['validation.cardinality_mismatch:error']);
    expect(
      codes(validateMappingInput(mappingInput([sourceValue('csv', 'email', ['a', 1])])))
    ).toEqual(['validation.cardinality_mismatch:error', 'validation.type_mismatch:error']);
  });

  it('builds one trace entry per reason', () => {
    const result = validateMappingInput(mappingInput([sourceValue('csv', 'email', 5)]));
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]?.reason).toEqual(result.reasons[0]);
  });
});

describe('transform validation', () => {
  it('appends the reasons of every transform step', () => {
    const bad: MappingTransformStep = {
      id: 'transform.case',
      inputEdgeIds: ['edge-0'],
      operation: 'case',
      outputTargetRef: canonicalEmail,
    };
    const input: MappingInput = { ...mappingInput([]), transforms: [bad, bad] };
    const result = validateMappingInput(input);
    expect(result.reasons).toHaveLength(2);
    expect(result.reasons[0]?.code).toBe('transform.missing_parameter');
    expect(result.reasons[1]).toEqual(result.reasons[0]);
  });
});

describe('validation rule dispatch', () => {
  it('ignores parameters that belong to other rule kinds', () => {
    const foreign = {
      valueType: 'number',
      allowedValues: ['x'],
      format: 'email',
      cardinality: 'multi',
    };
    const result = validateValue('abc', [rule('required', foreign)]);
    expect(result.reasons).toEqual([]);
    for (const kind of ['type', 'enum', 'format', 'cardinality'] as const) {
      const others = validateValue('abc', [rule('required', foreign), rule(kind, {})]);
      expect(others.reasons).toEqual([]);
    }
  });

  it('does not run value rules when no value matches the target', () => {
    const other: FieldRef = { side: 'source', namespace: 'csv', path: 'other' };
    const result = validateValue('abc', [
      rule('type', { valueType: 'number' }, undefined, other),
      rule('enum', { allowedValues: ['x'] }, undefined, other),
      rule('format', { format: 'phone' }, undefined, other),
      rule('cardinality', { cardinality: 'multi' }, undefined, other),
    ]);
    expect(result.reasons).toEqual([]);
  });
});

describe('required rules', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['empty array', []],
  ])('reports a %s value as missing', (_label, value) => {
    expect(codes(validateValue(value, [rule('required')]))).toEqual([
      'validation.required_missing:critical',
    ]);
  });

  it.each([
    ['zero', 0],
    ['false', false],
    ['text', 'x'],
    ['array with items', [1]],
    ['whitespace', ' '],
  ])('accepts %s', (_label, value) => {
    expect(validateValue(value, [rule('required')]).reasons).toEqual([]);
  });

  it('reports a missing field and honours the configured severity', () => {
    const other: FieldRef = { side: 'source', namespace: 'csv', path: 'other' };
    expect(codes(validateValue('x', [rule('required', undefined, undefined, other)]))).toEqual([
      'validation.required_missing:critical',
    ]);
    const warned = validateValue('', [rule('required', undefined, 'warning')]);
    expect(codes(warned)).toEqual(['validation.required_missing:warning']);
    expect(warned.status).toBe('partial');
    expect(validateValue('', [rule('required')]).status).toBe('failed');
  });
});

describe('type rules', () => {
  it.each([
    ['string', 'a', true],
    ['string', 1, false],
    ['number', 1, true],
    ['number', '1', false],
    ['boolean', true, true],
    ['boolean', false, true],
    ['boolean', 'true', false],
    ['boolean', 1, false],
    ['json', { a: 1 }, true],
    ['json', ['a'], true],
    ['json', 'a', false],
    ['custom', 'anything', true],
    ['number', [1, 2], true],
    ['number', [1, '2'], false],
    ['string', [], true],
    ['number', '', true],
    ['number', null, true],
    ['number', undefined, true],
    ['boolean', '', true],
  ])('type %s of %j matches=%s', (valueType, value, matches) => {
    const result = validateValue(value, [rule('type', { valueType })]);
    expect(codes(result)).toEqual(matches ? [] : ['validation.type_mismatch:error']);
  });

  it('ignores a missing or non-string valueType and honours severity', () => {
    expect(validateValue(1, [rule('type')]).reasons).toEqual([]);
    expect(validateValue(1, [rule('type', { valueType: 5 })]).reasons).toEqual([]);
    expect(codes(validateValue(1, [rule('type', { valueType: 'string' }, 'info')]))).toEqual([
      'validation.type_mismatch:info',
    ]);
  });
});

describe('enum rules', () => {
  it('reports values outside the allowed list', () => {
    expect(codes(validateValue('b', [rule('enum', { allowedValues: ['a'] })]))).toEqual([
      'validation.value_not_allowed:error',
    ]);
    expect(validateValue('a', [rule('enum', { allowedValues: ['a', 'b'] })]).reasons).toEqual([]);
    expect(codes(validateValue('a', [rule('enum', { allowedValues: [] }, 'critical')]))).toEqual([
      'validation.value_not_allowed:critical',
    ]);
  });

  it('ignores rules without an allowed list array', () => {
    expect(validateValue('a', [rule('enum')]).reasons).toEqual([]);
    expect(validateValue('a', [rule('enum', { allowedValues: 'a' })]).reasons).toEqual([]);
  });
});

describe('cardinality rules', () => {
  it.each([
    ['single', ['a'], true],
    ['single', [], true],
    ['single', 'a', false],
    ['single', '', false],
    ['multi', 'a', true],
    ['multi', 0, true],
    ['multi', ['a'], false],
    ['multi', [], false],
    ['multi', '', false],
    ['multi', null, false],
    ['multi', undefined, false],
    ['other', ['a'], false],
    ['other', 'a', false],
  ])('cardinality %s of %j mismatch=%s', (cardinality, value, mismatch) => {
    const result = validateValue(value, [rule('cardinality', { cardinality })]);
    expect(codes(result)).toEqual(mismatch ? ['validation.cardinality_mismatch:error'] : []);
  });

  it('honours the configured severity and ignores a missing cardinality parameter', () => {
    expect(
      codes(validateValue(['a'], [rule('cardinality', { cardinality: 'single' }, 'warning')]))
    ).toEqual(['validation.cardinality_mismatch:warning']);
    expect(validateValue(['a'], [rule('cardinality')]).reasons).toEqual([]);
  });
});

describe('format rules', () => {
  const formatCodes = (format: string | undefined, value: unknown) =>
    codes(validateValue(value, [rule('format', format === undefined ? {} : { format })]));
  const mismatch = ['validation.format_mismatch:warning'];

  it('uses warning severity by default and honours overrides', () => {
    expect(formatCodes('email', 'nope')).toEqual(mismatch);
    expect(codes(validateValue('nope', [rule('format', { format: 'email' }, 'critical')]))).toEqual(
      ['validation.format_mismatch:critical']
    );
  });

  it('skips non-string values and a missing format', () => {
    expect(formatCodes('email', 5)).toEqual([]);
    expect(formatCodes('email', ['bad'])).toEqual([]);
    expect(formatCodes('email', undefined)).toEqual([]);
    expect(formatCodes(undefined, 'nope')).toEqual([]);
    expect(formatCodes('', 'nope')).toEqual([]);
  });

  it('treats unknown formats as always valid', () => {
    expect(formatCodes('unknown-format', 'whatever')).toEqual([]);
  });

  it.each([
    ['a@b.co', true],
    ['a.b@c.d.e', true],
    ['a..b@c.co', true],
    ['a@b.co', true],
    ['nodomain', false],
    ['@b.co', false],
    ['a@@b.co', false],
    ['a@b@c.co', false],
    ['a@', false],
    ['a@b', false],
    ['a.b@c', false],
    ['x@.b', false],
    ['a@.b.co', false],
    ['a@b.co.', false],
    ['a@b..co', false],
    ['a@b.c..d', false],
    [' a@b.co', false],
    ['a @b.co', false],
    ['a@b .co', false],
    ['a@b.co ', false],
    ['a\t@b.co', false],
    ['a@b.\tco', false],
    ['a\n@b.co', false],
    ['a@b.co\n', false],
    ['a\r@b.co', false],
    ['a@b.co\r', false],
  ])('email %j valid=%s', (value, valid) => {
    expect(formatCodes('email', value)).toEqual(valid ? [] : mismatch);
  });

  it.each([
    ['https://example.test/path', true],
    ['mailto:a@b.test', true],
    ['not a uri', false],
    ['/relative', false],
    ['', false],
  ])('uri %j valid=%s', (value, valid) => {
    expect(formatCodes('uri', value)).toEqual(valid ? [] : mismatch);
  });

  it.each([
    ['2026-01-02', true],
    [' 2026-01-02', false],
    ['2026-01-02 ', false],
    ['2026-01-02T00:00:00Z', false],
    ['2026-1-02', false],
    ['2026-01-2', false],
    ['26-01-02', false],
    ['abcd-01-02', false],
    ['2026-ab-02', false],
    ['2026-01-ab', false],
    ['2026/01/02', false],
  ])('date %j valid=%s', (value, valid) => {
    expect(formatCodes('date', value)).toEqual(valid ? [] : mismatch);
  });

  it.each([
    ['2026-01-02T03:04:05Z', true],
    ['2026-01-02', true],
    ['not a date', false],
    ['2026-13-45T99:99:99Z', false],
  ])('datetime %j valid=%s', (value, valid) => {
    expect(formatCodes('datetime', value)).toEqual(valid ? [] : mismatch);
  });

  it.each([
    ['+81 3-1234-5678', true],
    ['1234567', true],
    ['12345678', true],
    ['+1234567', true],
    ['123.456.7890', true],
    ['123456', false],
    ['++1234567', false],
    ['-1234567', false],
    ['a234567', false],
    ['1a34567', false],
    ['1234567x', false],
    ['x1234567', false],
    ['1234567 x', false],
    ['+123456', false],
  ])('phone %j valid=%s', (value, valid) => {
    expect(formatCodes('phone', value)).toEqual(valid ? [] : mismatch);
  });

  it.each([
    ['ja', true],
    ['jpn', true],
    ['ja-JP', true],
    ['jpn-US', true],
    ['j', false],
    ['jpns', false],
    ['JA', false],
    ['ja-jp', false],
    ['ja-J', false],
    ['ja-JPN', false],
    ['ja-12', false],
    ['12', false],
    ['ja-', false],
    [' ja', false],
    ['ja ', false],
    ['ja-JP ', false],
  ])('locale %j valid=%s', (value, valid) => {
    expect(formatCodes('locale', value)).toEqual(valid ? [] : mismatch);
  });
});

describe('sameFieldRef', () => {
  const ref = (overrides: Partial<FieldRef>): FieldRef => ({
    side: 'source',
    namespace: 'csv',
    path: 'email',
    ...overrides,
  });

  it('compares catalog entry ids when both references have one', () => {
    expect(
      sameFieldRef(
        ref({ catalogEntryId: 'a' }),
        ref({ catalogEntryId: 'a', path: 'other', side: 'target' as never })
      )
    ).toBe(true);
    expect(sameFieldRef(ref({ catalogEntryId: 'a' }), ref({ catalogEntryId: 'b' }))).toBe(false);
  });

  it('falls back to side, namespace and path otherwise', () => {
    expect(sameFieldRef(ref({}), ref({}))).toBe(true);
    expect(sameFieldRef(ref({ catalogEntryId: 'a' }), ref({}))).toBe(true);
    expect(sameFieldRef(ref({}), ref({ catalogEntryId: 'a' }))).toBe(true);
    expect(sameFieldRef(ref({ catalogEntryId: '' }), ref({ catalogEntryId: 'x' }))).toBe(true);
    expect(sameFieldRef(ref({ side: 'canonical' }), ref({}))).toBe(false);
    expect(sameFieldRef(ref({ namespace: 'scim' }), ref({}))).toBe(false);
    expect(sameFieldRef(ref({ path: 'name' }), ref({}))).toBe(false);
    expect(sameFieldRef(ref({ catalogEntryId: 'a', path: 'name' }), ref({}))).toBe(false);
  });

  it('decides which source value a rule applies to', () => {
    const otherNamespace: FieldRef = { side: 'source', namespace: 'other', path: 'email' };
    const result = validateValue('x', [rule('required', undefined, undefined, otherNamespace)]);
    expect(codes(result)).toEqual(['validation.required_missing:critical']);
    const byId = validateMappingInput({
      ...mappingInput([
        {
          ...sourceValue('csv', 'email', ''),
          sourceRef: fieldRef('csv', 'email', 'field.csv.email'),
        },
      ]),
      validationRules: [
        rule('required', undefined, undefined, {
          side: 'source',
          namespace: 'zzz',
          path: 'zzz',
          catalogEntryId: 'field.csv.email',
        }),
      ],
    });
    expect(codes(byId)).toEqual(['validation.required_missing:critical']);
  });
});
