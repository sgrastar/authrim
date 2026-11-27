import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_CONDITION_TYPES,
  CHECK_API_CONDITION_TYPES,
  isKnownConditionType,
  validatePolicyConditions,
} from '../engine';

function validate(type: string, params: Record<string, unknown>): string | null {
  return validatePolicyConditions([{ type, params }]);
}

describe('validatePolicyConditions: the shape of the conditions', () => {
  it('requires an array', () => {
    for (const value of [undefined, null, 'x', 5, {}]) {
      expect(validatePolicyConditions(value)).toBe('conditions must be an array');
    }
    expect(validatePolicyConditions([])).toBeNull();
  });

  it('requires each condition to be an object, and names its index', () => {
    const ok = { type: 'is_resource_owner', params: {} };
    for (const bad of [null, undefined, 0, 'x', 5, true, []]) {
      expect(validatePolicyConditions([ok, bad])).toBe('conditions[1] must be an object');
    }
  });

  it('requires a known type', () => {
    expect(validatePolicyConditions([{ type: 'nope', params: {} }])).toBe(
      'conditions[0].type is not a known condition type'
    );
    expect(validatePolicyConditions([{ params: {} }])).toBe(
      'conditions[0].type is not a known condition type'
    );
    expect(validatePolicyConditions([{ type: 5, params: {} }])).toBe(
      'conditions[0].type is not a known condition type'
    );
    expect(validatePolicyConditions([{ type: 'toString', params: {} }])).toBe(
      'conditions[0].type is not a known condition type'
    );
  });

  it('requires an object of parameters', () => {
    for (const params of [undefined, null, 'x', 5, []]) {
      expect(validatePolicyConditions([{ type: 'is_resource_owner', params }])).toBe(
        'conditions[0].params must be an object'
      );
    }
  });

  it('names a parameter the type does not take, and one that is missing or invalid', () => {
    expect(validate('is_resource_owner', { extra: 1 })).toBe(
      'conditions[0].params.extra is not a parameter of is_resource_owner'
    );
    expect(validate('has_role', {})).toBe(
      'conditions[0].params.role is missing or not valid for has_role'
    );
    expect(validate('has_role', { role: 5 })).toBe(
      'conditions[0].params.role is missing or not valid for has_role'
    );
    expect(validate('has_role', { role: 'admin', toString: 'x' })).toBe(
      'conditions[0].params.toString is not a parameter of has_role'
    );
  });

  it('limits the types to those given and names the type that is refused', () => {
    const allowed = new Set(['has_role']);
    expect(validatePolicyConditions([{ type: 'is_resource_owner', params: {} }], allowed)).toBe(
      'conditions[0].type is_resource_owner cannot be evaluated here'
    );
    expect(
      validatePolicyConditions([{ type: 'has_role', params: { role: 'a' } }], allowed)
    ).toBeNull();
  });

  it('refuses checkExpiry false only where expired attributes are unknown', () => {
    const condition = { type: 'attribute_exists', params: { name: 'tier', checkExpiry: false } };
    expect(validatePolicyConditions([condition])).toBeNull();
    expect(validatePolicyConditions([condition], undefined, {})).toBeNull();
    expect(
      validatePolicyConditions([condition], undefined, { expiredAttributesKnown: true })
    ).toBeNull();
    expect(
      validatePolicyConditions([condition], undefined, { expiredAttributesKnown: false })
    ).toBe(
      'conditions[0].params.checkExpiry cannot be false here: expired attributes are not available'
    );
    const trueFlag = { type: 'attribute_exists', params: { name: 'tier', checkExpiry: true } };
    expect(
      validatePolicyConditions([trueFlag], undefined, { expiredAttributesKnown: false })
    ).toBeNull();
    const plain = { type: 'attribute_exists', params: { name: 'tier' } };
    expect(
      validatePolicyConditions([plain], undefined, { expiredAttributesKnown: false })
    ).toBeNull();
  });

  it('checks range bounds of date and numeric ranges', () => {
    expect(validate('valid_during', { from: 100, to: 200 })).toBeNull();
    expect(validate('valid_during', { from: 100, to: 100 })).toBeNull();
    expect(validate('valid_during', { from: 100 })).toBeNull();
    expect(validate('valid_during', { to: 100 })).toBeNull();
    expect(validate('valid_during', { from: 200, to: 100 })).toBe(
      'conditions[0].params.from is after params.to'
    );
    expect(validate('numeric_between', { name: 'age', min: 1, max: 2 })).toBeNull();
    expect(validate('numeric_between', { name: 'age', min: 2, max: 2 })).toBeNull();
    expect(validate('numeric_between', { name: 'age', min: 3, max: 2 })).toBe(
      'conditions[0].params.min is above params.max'
    );
  });
});

describe('validatePolicyConditions: what each parameter must be', () => {
  const invalid = (type: string, params: Record<string, unknown>): void => {
    expect(validate(type, params)).toMatch(/is missing or not valid for/);
  };

  it('text is a non-empty string', () => {
    expect(validate('has_role', { role: 'a' })).toBeNull();
    invalid('has_role', { role: '' });
    invalid('has_role', { role: 5 });
    invalid('has_role', { role: null });
  });

  it('a list of texts is a non-empty list of non-empty strings', () => {
    expect(validate('has_any_role', { roles: ['a', 'b'] })).toBeNull();
    invalid('has_any_role', { roles: [] });
    invalid('has_any_role', { roles: 'a' });
    invalid('has_any_role', { roles: ['a', 5] });
    invalid('has_any_role', { roles: [5, 'a'] });
    invalid('has_any_role', { roles: ['a', ''] });
  });

  it('a number is finite', () => {
    expect(validate('numeric_gt', { name: 'age', value: 0 })).toBeNull();
    expect(validate('numeric_gt', { name: 'age', value: -1.5 })).toBeNull();
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '5', null]) {
      invalid('numeric_gt', { name: 'age', value });
    }
  });

  it('a flag is a boolean', () => {
    expect(validate('attribute_exists', { name: 'a', checkExpiry: true })).toBeNull();
    invalid('attribute_exists', { name: 'a', checkExpiry: 'yes' });
    invalid('attribute_exists', { name: 'a', checkExpiry: 1 });
    invalid('attribute_exists', { name: 'a', checkExpiry: null });
  });

  it('an attribute value is any string, even empty', () => {
    expect(validate('attribute_equals', { name: 'a', value: '' })).toBeNull();
    invalid('attribute_equals', { name: 'a', value: 5 });
    invalid('attribute_equals', { name: 'a', value: undefined });
  });

  it('hours are integers within their ranges', () => {
    expect(validate('time_in_range', { startHour: 0, endHour: 24 })).toBeNull();
    expect(validate('time_in_range', { startHour: 23, endHour: 0 })).toBeNull();
    for (const startHour of [24, -1, 1.5, '5', Number.NaN]) {
      invalid('time_in_range', { startHour, endHour: 5 });
    }
    for (const endHour of [25, -1, 1.5, '5']) {
      invalid('time_in_range', { startHour: 5, endHour });
    }
  });

  it('days are a non-empty list of integers 0 to 6', () => {
    expect(validate('day_of_week', { allowedDays: [0, 6] })).toBeNull();
    invalid('day_of_week', { allowedDays: [] });
    invalid('day_of_week', { allowedDays: 3 });
    invalid('day_of_week', { allowedDays: [1, 7] });
    invalid('day_of_week', { allowedDays: [7, 1] });
    invalid('day_of_week', { allowedDays: [-1] });
    invalid('day_of_week', { allowedDays: [1.5] });
    invalid('day_of_week', { allowedDays: ['1'] });
  });

  it('a time zone is an IANA name the runtime knows', () => {
    expect(validate('day_of_week', { allowedDays: [1], timezone: 'Asia/Tokyo' })).toBeNull();
    expect(validate('day_of_week', { allowedDays: [1], timezone: 'UTC' })).toBeNull();
    expect(validate('day_of_week', { allowedDays: [1] })).toBeNull();
    for (const timezone of ['Nowhere/City', '', 5, null]) {
      invalid('day_of_week', { allowedDays: [1], timezone });
      invalid('time_in_range', { startHour: 1, endHour: 2, timezone });
    }
  });

  it('times in a range are positive safe integers in seconds', () => {
    expect(validate('valid_during', { from: 1, to: Number.MAX_SAFE_INTEGER })).toBeNull();
    for (const bound of [0, -1, 1.5, '5', Number.NaN, 2 ** 53, null]) {
      invalid('valid_during', { from: bound });
      invalid('valid_during', { to: bound });
    }
  });

  it('a role scope is global, group or resource', () => {
    for (const scope of ['global', 'group', 'resource']) {
      expect(validate('has_role', { role: 'a', scope })).toBeNull();
    }
    for (const scope of ['tenant', 'org', '', 'Group', 5]) {
      invalid('has_role', { role: 'a', scope });
    }
    expect(validate('has_role', { role: 'a', scopeTarget: 'group:1' })).toBeNull();
    invalid('has_role', { role: 'a', scopeTarget: '' });
  });
});

describe('the condition type sets', () => {
  it('knows exactly the evaluator types', () => {
    for (const type of [...ATTRIBUTE_CONDITION_TYPES, ...CHECK_API_CONDITION_TYPES]) {
      expect(isKnownConditionType(type)).toBe(true);
    }
    for (const type of ['nope', '', 5, null, undefined, 'toString', 'constructor']) {
      expect(isKnownConditionType(type)).toBe(false);
    }
  });

  it('lists the types that read verified attributes', () => {
    expect([...ATTRIBUTE_CONDITION_TYPES].sort()).toEqual([
      'attribute_equals',
      'attribute_exists',
      'attribute_in',
      'numeric_between',
      'numeric_eq',
      'numeric_gt',
      'numeric_gte',
      'numeric_lt',
      'numeric_lte',
    ]);
  });

  it('lists the types the Check API can evaluate', () => {
    expect([...CHECK_API_CONDITION_TYPES].sort()).toEqual([
      'attribute_equals',
      'attribute_exists',
      'attribute_in',
      'day_of_week',
      'has_all_roles',
      'has_any_role',
      'has_role',
      'is_resource_owner',
      'numeric_between',
      'numeric_eq',
      'numeric_gt',
      'numeric_gte',
      'numeric_lt',
      'numeric_lte',
      'time_in_range',
      'valid_during',
    ]);
  });
});
