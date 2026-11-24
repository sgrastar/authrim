import { describe, expect, it } from 'vitest';
import {
  buildArray,
  conditionalInputsProblem,
  executeConditional,
  structureSettingsProblem,
} from '../../core/structure-transforms';
import { TransformFailure } from '../../core/transform-safety';
import type { FieldRef, MappingTransformStep, TransformOperation } from '../../core/types';

const target: FieldRef = { side: 'destination', namespace: 'synthetic', path: 'output' };
const condition = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ kind: 'rule', field: 'department', operator: 'eq', value: 'hr', ...extra });
const twoFields = JSON.stringify({
  kind: 'group',
  match: 'all',
  children: [
    { kind: 'rule', field: 'a', operator: 'exists', value: null },
    { kind: 'rule', field: 'b', operator: 'exists', value: null },
  ],
});
function step(
  operation: TransformOperation,
  parameters: Record<string, unknown> | undefined,
  inputNames?: (string | undefined)[]
): MappingTransformStep {
  return { id: 's', operation, parameters, inputEdgeIds: [], inputNames, outputTargetRef: target };
}
function failure(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof TransformFailure) return error.code;
    throw error;
  }
  return undefined;
}

describe('conditionalInputsProblem', () => {
  it('accepts exactly the value and field inputs the condition reads, in any order', () => {
    expect(
      conditionalInputsProblem({ condition: condition() }, ['value', 'field:department'])
    ).toBe(false);
    expect(
      conditionalInputsProblem({ condition: condition() }, ['field:department', 'value'])
    ).toBe(false);
    expect(
      conditionalInputsProblem({ condition: twoFields }, ['field:b', 'value', 'field:a'])
    ).toBe(false);
  });

  it('refuses an unreadable or absent condition', () => {
    expect(conditionalInputsProblem(undefined, ['value'])).toBe(true);
    expect(conditionalInputsProblem({}, ['value'])).toBe(true);
    expect(conditionalInputsProblem({ condition: 'nope' }, ['value'])).toBe(true);
  });

  it('refuses missing, extra, repeated or unrelated inputs', () => {
    const parameters = { condition: condition() };
    expect(conditionalInputsProblem(parameters, ['value'])).toBe(true);
    expect(conditionalInputsProblem(parameters, [])).toBe(true);
    expect(conditionalInputsProblem(parameters, ['value', 'field:department', 'extra'])).toBe(true);
    expect(conditionalInputsProblem(parameters, ['value', 'value'])).toBe(true);
    expect(conditionalInputsProblem(parameters, ['value', 'field:other'])).toBe(true);
    expect(conditionalInputsProblem(parameters, [undefined, 'field:department'])).toBe(true);
    expect(conditionalInputsProblem({ condition: twoFields }, ['value', 'value', 'field:a'])).toBe(
      true
    );
  });
});

describe('structureSettingsProblem', () => {
  const settings = (parameters: Record<string, unknown> | undefined, names?: string[]) =>
    structureSettingsProblem(
      step('conditional', parameters, names ?? ['value', 'field:department'])
    );
  const number = (value: unknown) => structureSettingsProblem(step('constant_number', { value }));

  it('accepts only finite numbers within the safe range for constant_number', () => {
    expect(number(5)).toBe(false);
    expect(number(0)).toBe(false);
    expect(number(-1.5)).toBe(false);
    expect(number(Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(number(-Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(number(2 ** 53)).toBe(true);
    expect(number(-(2 ** 53))).toBe(true);
    expect(number(1e300)).toBe(true);
    expect(number(Number.NaN)).toBe(true);
    expect(number(Number.POSITIVE_INFINITY)).toBe(true);
    expect(number(Number.NEGATIVE_INFINITY)).toBe(true);
    expect(number('5')).toBe(true);
    expect(number(undefined)).toBe(true);
    expect(structureSettingsProblem(step('constant_number', undefined))).toBe(true);
  });

  it('has no opinion about other operations', () => {
    expect(structureSettingsProblem(step('hash', {}))).toBe(false);
    expect(structureSettingsProblem(step('constant_text', { value: 5 }))).toBe(false);
    expect(structureSettingsProblem(step('array_build', undefined))).toBe(false);
  });

  const base = { condition: condition(), valueType: 'as_text', elseMode: 'as_is' };

  it('checks the condition and its inputs', () => {
    expect(settings({ ...base, thenValue: 'x' })).toBe(false);
    expect(settings({ ...base, thenValue: 'x' }, ['value'])).toBe(true);
    expect(settings({ ...base, condition: 'nope', thenValue: 'x' })).toBe(true);
    expect(settings(undefined)).toBe(true);
    expect(structureSettingsProblem(step('conditional', { ...base, thenValue: 'x' }))).toBe(true);
  });

  it('needs a text then-value for text results, and an else-value only for fixed', () => {
    expect(settings({ ...base })).toBe(true);
    expect(settings({ ...base, thenValue: 5 })).toBe(true);
    expect(settings({ ...base, thenValue: '' })).toBe(false);
    expect(settings({ ...base, thenValue: 'x', elseMode: 'fixed' })).toBe(true);
    expect(settings({ ...base, thenValue: 'x', elseMode: 'fixed', elseValue: 5 })).toBe(true);
    expect(settings({ ...base, thenValue: 'x', elseMode: 'fixed', elseValue: 'y' })).toBe(false);
    expect(settings({ ...base, thenValue: 'x', elseMode: 'none', elseValue: 5 })).toBe(false);
    expect(settings({ ...base, thenValue: 'x', elseMode: 'as_is' })).toBe(false);
  });

  it('needs true or false for boolean results', () => {
    const boolean = { ...base, valueType: 'as_boolean' };
    expect(settings({ ...boolean, thenBool: 'true' })).toBe(false);
    expect(settings({ ...boolean, thenBool: 'false' })).toBe(false);
    expect(settings({ ...boolean })).toBe(true);
    expect(settings({ ...boolean, thenBool: 'yes' })).toBe(true);
    expect(settings({ ...boolean, thenBool: true })).toBe(true);
    expect(settings({ ...boolean, thenValue: 'true' })).toBe(true);
    expect(settings({ ...boolean, thenBool: 'true', elseMode: 'fixed' })).toBe(true);
    expect(settings({ ...boolean, thenBool: 'true', elseMode: 'fixed', elseBool: 'x' })).toBe(true);
    expect(settings({ ...boolean, thenBool: 'true', elseMode: 'fixed', elseBool: 'false' })).toBe(
      false
    );
    expect(settings({ ...boolean, thenBool: 'true', elseMode: 'as_is', elseBool: 'x' })).toBe(
      false
    );
  });

  it.each([
    ['5', true],
    ['55', true],
    ['-5', true],
    ['  7  ', true],
    [' 7', true],
    ['7 ', true],
    ['  -7.25', true],
    ['1.55', true],
    ['0', true],
    ['9007199254740991', true],
    ['-9007199254740991', true],
    ['9007199254740992', false],
    ['-9007199254740992', false],
    ['1' + '0'.repeat(400), false],
    ['', false],
    [' ', false],
    ['1.', false],
    ['.5', false],
    ['1e3', false],
    ['0x10', false],
    ['+5', false],
    ['5a', false],
    ['a5', false],
    ['1,5', false],
    ['--5', false],
    ['1.5.5', false],
  ])('judges the number text %j as valid: %s', (text, valid) => {
    const numeric = { ...base, valueType: 'as_number' };
    expect(settings({ ...numeric, thenValue: text })).toBe(!valid);
    expect(settings({ ...numeric, thenValue: '1', elseMode: 'fixed', elseValue: text })).toBe(
      !valid
    );
  });

  it('lets the else-value be anything when it is not used', () => {
    const numeric = { ...base, valueType: 'as_number', thenValue: '1' };
    expect(settings({ ...numeric, elseMode: 'none', elseValue: 'abc' })).toBe(false);
    expect(settings({ ...numeric, elseMode: 'as_is' })).toBe(false);
  });
});

describe('executeConditional', () => {
  const names = ['value', 'field:department'];
  const exec = (parameters: Record<string, unknown>, values: unknown[]) =>
    executeConditional(step('conditional', parameters, names), values);
  const base = { condition: condition(), valueType: 'as_text', elseMode: 'as_is' };

  it('returns the then-result when the condition holds', () => {
    expect(exec({ ...base, thenValue: 'T' }, ['v', 'hr'])).toBe('T');
    expect(exec({ ...base, valueType: 'as_boolean', thenBool: 'true' }, ['v', 'hr'])).toBe(true);
    expect(exec({ ...base, valueType: 'as_boolean', thenBool: 'false' }, ['v', 'hr'])).toBe(false);
    expect(exec({ ...base, valueType: 'as_number', thenValue: '12.5' }, ['v', 'hr'])).toBe(12.5);
    expect(exec({ ...base, valueType: 'as_number', thenValue: ' -3 ' }, ['v', 'hr'])).toBe(-3);
  });

  it('applies the else mode when it does not', () => {
    expect(exec({ ...base, thenValue: 'T' }, ['v', 'it'])).toBe('v');
    expect(exec({ ...base, thenValue: 'T', elseMode: 'none' }, ['v', 'it'])).toBeNull();
    expect(exec({ ...base, thenValue: 'T', elseMode: 'fixed', elseValue: 'E' }, ['v', 'it'])).toBe(
      'E'
    );
    expect(
      exec(
        {
          ...base,
          valueType: 'as_boolean',
          thenBool: 'true',
          elseMode: 'fixed',
          elseBool: 'false',
        },
        ['v', 'it']
      )
    ).toBe(false);
    expect(
      exec(
        {
          ...base,
          valueType: 'as_boolean',
          thenBool: 'false',
          elseMode: 'fixed',
          elseBool: 'true',
        },
        ['v', 'it']
      )
    ).toBe(true);
    expect(
      exec({ ...base, valueType: 'as_number', thenValue: '1', elseMode: 'fixed', elseValue: '2' }, [
        'v',
        'it',
      ])
    ).toBe(2);
    expect(exec({ ...base, thenValue: 'T' }, [['x', 'y'], 'it'])).toEqual(['x', 'y']);
  });

  it('reads condition fields from the named inputs, not from position', () => {
    const swapped = step('conditional', { ...base, thenValue: 'T' }, ['field:department', 'value']);
    expect(executeConditional(swapped, ['hr', 'v'])).toBe('T');
    expect(executeConditional(swapped, ['it', 'v'])).toBe('v');
  });

  it('works without any named inputs', () => {
    const missing = condition({ operator: 'not_exists', value: null });
    expect(
      executeConditional(
        step('conditional', { ...base, condition: missing, thenValue: 'T' }, undefined),
        []
      )
    ).toBe('T');
    expect(
      executeConditional(
        step('conditional', { ...base, condition: missing, thenValue: 'T' }, [
          undefined,
          'field:department',
        ]),
        ['v', 'x']
      )
    ).toBeUndefined();
  });

  it('rejects an unreadable condition', () => {
    expect(failure(() => exec({ ...base, condition: 'nope', thenValue: 'T' }, ['v', 'hr']))).toBe(
      'transform.invalid_parameter'
    );
    expect(failure(() => exec({ ...base, thenValue: 'T', condition: undefined }, []))).toBe(
      'transform.invalid_parameter'
    );
  });
});

describe('buildArray', () => {
  it('flattens one level and keeps types', () => {
    expect(buildArray([1, [2, [3]], 'a', [], ['b']], undefined)).toEqual([1, 2, [3], 'a', 'b']);
    expect(buildArray(['x'], {})).toEqual(['x']);
    expect(buildArray([0, false, ''], {})).toEqual([0, false, '']);
  });

  it('always drops null and undefined', () => {
    expect(buildArray([null, undefined, 'a', [null, undefined, 'b']], {})).toEqual(['a', 'b']);
    expect(buildArray([null], { omitEmpty: true })).toEqual([]);
  });

  it('drops empty text and empty lists only with omitEmpty', () => {
    const values = ['', 'a', [[]], 0, false, [[], 'b']];
    expect(buildArray(values, {})).toEqual(['', 'a', [], 0, false, [], 'b']);
    expect(buildArray(values, { omitEmpty: false })).toEqual(['', 'a', [], 0, false, [], 'b']);
    expect(buildArray(values, { omitEmpty: true })).toEqual(['a', 0, false, 'b']);
    expect(buildArray([' '], { omitEmpty: true })).toEqual([' ']);
    expect(buildArray([[[1]], [[]], [['']]], { omitEmpty: true })).toEqual([[1], ['']]);
  });

  it('removes structural duplicates only with unique, keeping the first', () => {
    const values = [1, '1', { a: 1 }, { a: 1 }, [2], [2], 1, true, 'true'];
    expect(buildArray(values, {})).toHaveLength(9);
    expect(buildArray(values, { unique: false })).toHaveLength(9);
    expect(buildArray(values, { unique: true })).toEqual([1, '1', { a: 1 }, 2, true, 'true']);
    expect(buildArray([[1, 1], 1, '', ''], { unique: true, omitEmpty: true })).toEqual([1]);
    expect(buildArray(['b', 'a', 'b'], { unique: true })).toEqual(['b', 'a']);
  });
});
