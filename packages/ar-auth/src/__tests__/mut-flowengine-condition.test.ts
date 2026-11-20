/**
 * ConditionEvaluator - boundary and security-limit tests
 * (DoS size limits, non-finite numbers, ReDoS guards, prototype-safe key lookup)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluate, evaluateSingle, getValueByKey } from '../flow-engine/condition-evaluator.js';
import type { FlowCondition, ConditionGroup, FlowRuntimeContext } from '../flow-engine/types.js';

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const ctxWith = (value: unknown): FlowRuntimeContext => ({ form: { v: value } });

function check(operator: string, actual: unknown, expected?: unknown): boolean {
  return evaluateSingle(
    { key: 'form.v', operator, value: expected } as unknown as FlowCondition,
    ctxWith(actual)
  );
}

describe('recursion depth limit', () => {
  const leaf = { key: 'form.v', operator: 'isTrue' } as unknown as FlowCondition;
  const nest = (logic: 'and' | 'or', levels: number): FlowCondition | ConditionGroup => {
    let c: FlowCondition | ConditionGroup = leaf;
    for (let i = 0; i < levels; i++) c = { logic, conditions: [c] };
    return c;
  };

  it('allows depth exactly 10 and rejects 11', () => {
    expect(evaluate(leaf, ctxWith(true), 10)).toBe(true);
    expect(evaluate(leaf, ctxWith(true), 11)).toBe(false);
  });

  it('OR groups increase depth too', () => {
    expect(evaluate(nest('or', 10), ctxWith(true))).toBe(true);
    expect(evaluate(nest('or', 11), ctxWith(true))).toBe(false);
    expect(evaluate(nest('and', 11), ctxWith(true))).toBe(false);
  });
});

describe('equality / existence', () => {
  it('notEquals is false for equal values', () => {
    expect(check('notEquals', 'a', 'a')).toBe(false);
    expect(check('notEquals', 'a', 'b')).toBe(true);
  });

  it('exists / notExists treat null and undefined as missing', () => {
    expect(check('exists', null)).toBe(false);
    expect(check('exists', undefined)).toBe(false);
    expect(check('exists', 0)).toBe(true);
    expect(check('notExists', null)).toBe(true);
    expect(check('notExists', undefined)).toBe(true);
    expect(check('notExists', '')).toBe(false);
  });
});

describe('string operators and size limits', () => {
  const ok = 'a'.repeat(9999) + 'Z';
  const tooLong = 'a'.repeat(10000) + 'Z';

  it('contains: 10000 chars allowed, 10001 rejected', () => {
    expect(check('contains', ok, 'Z')).toBe(true);
    expect(check('contains', tooLong, 'Z')).toBe(false);
    expect(check('contains', 42, '4')).toBe(false);
  });

  it('notContains: 10000 chars allowed, 10001 rejected', () => {
    expect(check('notContains', ok, 'Q')).toBe(true);
    expect(check('notContains', ok, 'Z')).toBe(false);
    expect(check('notContains', tooLong, 'Q')).toBe(false);
    expect(check('notContains', 42, 'Q')).toBe(false);
  });

  it('startsWith: limit and non-string', () => {
    expect(check('startsWith', 'Z' + 'a'.repeat(9999), 'Z')).toBe(true);
    expect(check('startsWith', 'Z' + 'a'.repeat(10000), 'Z')).toBe(false);
    expect(check('startsWith', 42, '4')).toBe(false);
  });

  it('endsWith: limit and non-string', () => {
    expect(check('endsWith', ok, 'Z')).toBe(true);
    expect(check('endsWith', tooLong, 'Z')).toBe(false);
    expect(check('endsWith', 42, '2')).toBe(false);
  });
});

describe('array operators and size limits', () => {
  const arr = (n: number) => [...Array.from({ length: n - 1 }, (_, i) => i), 'x'];

  it('contains on arrays: 1000 allowed, 1001 rejected', () => {
    expect(check('contains', arr(1000), 'x')).toBe(true);
    expect(check('contains', arr(1001), 'x')).toBe(false);
  });

  it('notContains on arrays', () => {
    expect(check('notContains', ['a', 'b'], 'c')).toBe(true);
    expect(check('notContains', ['a', 'b'], 'a')).toBe(false);
    expect(check('notContains', arr(1000), 'y')).toBe(true);
    expect(check('notContains', arr(1001), 'y')).toBe(false);
  });

  it('in / notIn: 1000 allowed, 1001 rejected', () => {
    expect(check('in', 'x', arr(1000))).toBe(true);
    expect(check('in', 'x', arr(1001))).toBe(false);
    expect(check('notIn', 'y', arr(1000))).toBe(true);
    expect(check('notIn', 'y', arr(1001))).toBe(false);
    expect(check('notIn', 'x', arr(10))).toBe(false);
  });
});

describe('numeric comparisons', () => {
  it.each(['greaterThan', 'lessThan', 'greaterOrEqual', 'lessOrEqual'])(
    '%s rejects non-finite operands on either side',
    (op) => {
      expect(check(op, Infinity, 5)).toBe(false);
      expect(check(op, -Infinity, 5)).toBe(false);
      expect(check(op, NaN, 5)).toBe(false);
      expect(check(op, 5, Infinity)).toBe(false);
      expect(check(op, 5, -Infinity)).toBe(false);
      expect(check(op, '5', 5)).toBe(false);
    }
  );

  it('strict vs inclusive boundaries', () => {
    expect(check('greaterThan', 5, 5)).toBe(false);
    expect(check('greaterThan', 6, 5)).toBe(true);
    expect(check('lessThan', 5, 5)).toBe(false);
    expect(check('lessThan', 6, 5)).toBe(false);
    expect(check('lessThan', 4, 5)).toBe(true);
    expect(check('greaterOrEqual', 4, 5)).toBe(false);
    expect(check('greaterOrEqual', 5, 5)).toBe(true);
    expect(check('lessOrEqual', 6, 5)).toBe(false);
    expect(check('lessOrEqual', 5, 5)).toBe(true);
  });
});

describe('matches (ReDoS guards)', () => {
  it('allows a 100-char pattern and rejects 101 chars', () => {
    expect(check('matches', 'a'.repeat(100), 'a'.repeat(100))).toBe(true);
    expect(check('matches', 'a'.repeat(101), 'a'.repeat(101))).toBe(false);
  });

  it.each([
    // each pattern would match the input if it were not flagged as dangerous
    ['(ab+)+', 'abbb'],
    ['(a+b)+', 'aab'],
    ['(ab|c)*', 'x'],
    ['(ab)\\1+', 'ababab'],
    ['[ab]{1000}', 'a'.repeat(1000)],
    ['[ab]{100,1000}', 'a'.repeat(100)],
  ])('rejects dangerous pattern %s', (pattern, input) => {
    expect(new RegExp(pattern).test(input)).toBe(true);
    expect(check('matches', input, pattern)).toBe(false);
  });

  it.each([
    ['(.*a)', 'xa'],
    ['(.+a)', 'xa'],
    ['^[a-z]{2}$', 'ab'],
  ])('accepts safe pattern %s', (pattern, input) => {
    expect(check('matches', input, pattern)).toBe(true);
  });

  it('returns false (not undefined) for an invalid regex', () => {
    expect(check('matches', 'abc', '[a-')).toBe(false);
  });

  it('returns false for non-string operands', () => {
    expect(check('matches', 123, '1')).toBe(false);
  });
});

describe('boolean and unknown operators', () => {
  it('isTrue / isFalse are strict', () => {
    expect(check('isTrue', 'true')).toBe(false);
    expect(check('isFalse', 0)).toBe(false);
    expect(check('isFalse', false)).toBe(true);
  });

  it('unknown operator evaluates to false', () => {
    expect(check('bogus', true, true)).toBe(false);
  });
});

describe('getValueByKey prototype safety', () => {
  it('rejects dangerous segments even when present as own properties', () => {
    const ctx = { user: { constructor: 'own-value' } } as unknown as FlowRuntimeContext;
    expect(getValueByKey('user.constructor', ctx)).toBeUndefined();
    const ctx2 = { form: { prototype: 'p' } } as unknown as FlowRuntimeContext;
    expect(getValueByKey('form.prototype', ctx2)).toBeUndefined();
  });

  it('returns undefined when traversing through null', () => {
    const ctx = { user: null } as unknown as FlowRuntimeContext;
    expect(getValueByKey('user.email', ctx)).toBeUndefined();
  });

  it('does not descend into primitives', () => {
    const ctx = { user: { email: 'test' } } as unknown as FlowRuntimeContext;
    expect(getValueByKey('user.email.length', ctx)).toBeUndefined();
  });

  it('does not read inherited properties', () => {
    const ctx = { user: { email: 'x' } } as unknown as FlowRuntimeContext;
    expect(getValueByKey('user.toString', ctx)).toBeUndefined();
    expect(getValueByKey('user.hasOwnProperty', ctx)).toBeUndefined();
  });
});
