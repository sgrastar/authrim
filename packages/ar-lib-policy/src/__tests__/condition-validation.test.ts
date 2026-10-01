import { describe, expect, it } from 'vitest';
import { CHECK_API_CONDITION_TYPES, validatePolicyConditions } from '../engine';

describe('validatePolicyConditions', () => {
  it('accepts conditions with the parameters their types need', () => {
    expect(
      validatePolicyConditions([
        { type: 'has_role', params: { role: 'auditor', scope: 'org', scopeTarget: 'org:a' } },
        { type: 'attribute_equals', params: { name: 'tier', value: 'premium' } },
        { type: 'numeric_between', params: { name: 'age', min: 18, max: 65 } },
        { type: 'day_of_week', params: { allowedDays: [1, 2, 3] } },
        { type: 'valid_during', params: {} },
      ])
    ).toBeNull();
  });

  it.each([
    [{ type: 'numeric_gte', params: { name: 'age' } }, 'params.value'],
    [{ type: 'numeric_gte', params: { name: 'age', value: '18' } }, 'params.value'],
    [{ type: 'has_role', params: {} }, 'params.role'],
    [{ type: 'has_role', params: { role: 'a', scope: 'tenant' } }, 'params.scope'],
    [{ type: 'has_any_role', params: { roles: [] } }, 'params.roles'],
    [{ type: 'time_in_range', params: { startHour: 9, endHour: 30 } }, 'params.endHour'],
    [{ type: 'day_of_week', params: { allowedDays: [7] } }, 'params.allowedDays'],
    // A form's untouched number (0) is not a date: a range ending in 1970 never applies.
    [{ type: 'valid_during', params: { from: 2000000000, to: 0 } }, 'params.to'],
    [{ type: 'valid_during', params: { from: 2000003600, to: 2000000000 } }, 'params.from'],
    [{ type: 'numeric_between', params: { name: 'age', min: 65, max: 18 } }, 'params.min'],
    // A parameter of another name would be ignored: a date range that never limits anything.
    [{ type: 'valid_during', params: { start: 2000000000, end: 2000003600 } }, 'params.start'],
    [{ type: 'attribute_equals', params: { attribute: 'tier', value: 'x' } }, 'params.attribute'],
    [
      { type: 'time_in_range', params: { startHour: 9, endHour: 17, timezone: 'Asia/Tokyoo' } },
      'params.timezone',
    ],
    [{ type: 'attribute_in', params: { name: 'level', values: 'senior' } }, 'params.values'],
  ])('refuses a condition missing what its type needs %#', (condition, problem) => {
    expect(validatePolicyConditions([condition])).toContain(problem);
  });

  it('refuses counting expired attributes where they are not available', () => {
    const condition = {
      type: 'attribute_equals',
      params: { name: 'blocked', value: 'true', checkExpiry: false },
    };
    expect(validatePolicyConditions([condition])).toBeNull();
    expect(
      validatePolicyConditions([condition], CHECK_API_CONDITION_TYPES, {
        expiredAttributesKnown: false,
      })
    ).toContain('checkExpiry');
  });

  it('limits the types to what the Check API can evaluate', () => {
    for (const type of ['user_type_is', 'same_organization', 'country_not_in', 'ip_in_range']) {
      const params =
        type === 'user_type_is'
          ? { types: ['end_user'] }
          : type === 'ip_in_range'
            ? { ranges: ['10.0.0.0/8'] }
            : type === 'country_not_in'
              ? { countries: ['JP'] }
              : {};
      expect(validatePolicyConditions([{ type, params }])).toBeNull();
      expect(validatePolicyConditions([{ type, params }], CHECK_API_CONDITION_TYPES)).toContain(
        'cannot be evaluated here'
      );
    }
  });
});
