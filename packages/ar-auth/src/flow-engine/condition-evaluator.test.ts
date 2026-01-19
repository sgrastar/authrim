/**
 * ConditionEvaluator - ユニットテスト
 *
 * 各オペレーターの動作確認、AND/OR評価、ネスト条件の評価をテスト
 */

import { describe, it, expect } from 'vitest';
import {
  evaluate,
  evaluateGroup,
  evaluateSingle,
  getValueByKey,
} from './condition-evaluator.js';
import type {
  FlowCondition,
  ConditionGroup,
  FlowRuntimeContext,
} from './types.js';

// =============================================================================
// Test Data
// =============================================================================

const mockContext: FlowRuntimeContext = {
  user: {
    id: 'user_123',
    email: 'test@example.com',
    emailDomain: 'example.com',
    phone: '+1234567890',
    verifiedEmail: true,
    verifiedPhone: false,
    status: 'active',
    tenantIds: ['tenant_1', 'tenant_2'],
    roles: ['admin', 'user'],
    permissions: ['read', 'write'],
    customAttributes: {
      role: 'admin',
      department: 'engineering',
      level: 5,
    },
    isLoggedIn: true,
    hasPassword: true,
    hasTotp: false,
    hasWebAuthn: true,
    hasSocialLogin: false,
    mfaEnabled: false,
  },
  device: {
    type: 'desktop',
    os: 'macOS',
    browser: 'Chrome',
    webAuthnSupport: true,
    trustedDevice: false,
  },
  request: {
    country: 'US',
    city: 'New York',
    ip: '192.168.1.1',
    isVPN: false,
    isTor: false,
  },
  risk: {
    score: 30,
    botDetected: false,
    impossibleTravel: false,
    newDevice: true,
    newLocation: false,
  },
  form: {
    email: 'input@test.com',
    username: 'testuser',
  },
  prevNode: {
    success: true,
    result: 'password_verified',
  },
  variables: {
    customVar: 'customValue',
    count: 42,
  },
};

// =============================================================================
// getValueByKey Tests
// =============================================================================

describe('getValueByKey', () => {
  it('should get top-level value', () => {
    expect(getValueByKey('user', mockContext)).toBe(mockContext.user);
  });

  it('should get nested value', () => {
    expect(getValueByKey('user.email', mockContext)).toBe('test@example.com');
  });

  it('should get deeply nested value', () => {
    expect(getValueByKey('user.customAttributes.role', mockContext)).toBe('admin');
  });

  it('should return undefined for non-existent key', () => {
    expect(getValueByKey('user.nonExistent', mockContext)).toBeUndefined();
  });

  it('should return undefined for deeply non-existent key', () => {
    expect(getValueByKey('user.customAttributes.nonExistent', mockContext)).toBeUndefined();
  });

  it('should handle form input keys', () => {
    expect(getValueByKey('form.email', mockContext)).toBe('input@test.com');
  });

  it('should handle prevNode keys', () => {
    expect(getValueByKey('prevNode.success', mockContext)).toBe(true);
  });
});

// =============================================================================
// evaluateSingle Tests - String Operators
// =============================================================================

describe('evaluateSingle - String Operators', () => {
  it('should evaluate equals operator', () => {
    const condition: FlowCondition = {
      key: 'user.email',
      operator: 'equals',
      value: 'test@example.com',
    };
    expect(evaluateSingle(condition, mockContext)).toBe(true);

    const falseCondition: FlowCondition = {
      key: 'user.email',
      operator: 'equals',
      value: 'wrong@example.com',
    };
    expect(evaluateSingle(falseCondition, mockContext)).toBe(false);
  });

  it('should evaluate notEquals operator', () => {
    const condition: FlowCondition = {
      key: 'user.email',
      operator: 'notEquals',
      value: 'wrong@example.com',
    };
    expect(evaluateSingle(condition, mockContext)).toBe(true);
  });

  it('should evaluate contains operator', () => {
    const condition: FlowCondition = {
      key: 'user.email',
      operator: 'contains',
      value: 'example',
    };
    expect(evaluateSingle(condition, mockContext)).toBe(true);

    const falseCondition: FlowCondition = {
      key: 'user.email',
      operator: 'contains',
      value: 'notfound',
    };
    expect(evaluateSingle(falseCondition, mockContext)).toBe(false);
  });

  it('should evaluate notContains operator', () => {
    const condition: FlowCondition = {
      key: 'user.email',
      operator: 'notContains',
      value: 'notfound',
    };
    expect(evaluateSingle(condition, mockContext)).toBe(true);
  });

  it('should evaluate startsWith operator', () => {
    const condition: FlowCondition = {
      key: 'user.email',
      operator: 'startsWith',
      value: 'test@',
    };
    expect(evaluateSingle(condition, mockContext)).toBe(true);
  });

  it('should evaluate endsWith operator', () => {
    const condition: FlowCondition = {
      key: 'user.email',
      operator: 'endsWith',
      value: '.com',
    };
    expect(evaluateSingle(condition, mockContext)).toBe(true);
  });

  it('should evaluate matches operator (regex)', () => {
    const condition: FlowCondition = {
      key: 'user.email',
      operator: 'matches',
      value: '^test@.*\\.com$',
    };
    expect(evaluateSingle(condition, mockContext)).toBe(true);

    const falseCondition: FlowCondition = {
      key: 'user.email',
      operator: 'matches',
      value: '^admin@',
    };
    expect(evaluateSingle(falseCondition, mockContext)).toBe(false);
  });
});

// =============================================================================
// evaluateSingle Tests - Number Operators
// =============================================================================

describe('evaluateSingle - Number Operators', () => {
  it('should evaluate greaterThan operator', () => {
    const condition: FlowCondition = {
      key: 'risk.score',
      operator: 'greaterThan',
      value: 20,
    };
    expect(evaluateSingle(condition, mockContext)).toBe(true);

    const falseCondition: FlowCondition = {
      key: 'risk.score',
      operator: 'greaterThan',
      value: 50,
    };
    expect(evaluateSingle(falseCondition, mockContext)).toBe(false);
  });

  it('should evaluate lessThan operator', () => {
    const condition: FlowCondition = {
      key: 'risk.score',
      operator: 'lessThan',
      value: 50,
    };
    expect(evaluateSingle(condition, mockContext)).toBe(true);
  });

  it('should evaluate greaterOrEqual operator', () => {
    const condition: FlowCondition = {
      key: 'risk.score',
      operator: 'greaterOrEqual',
      value: 30,
    };
    expect(evaluateSingle(condition, mockContext)).toBe(true);
  });

  it('should evaluate lessOrEqual operator', () => {
    const condition: FlowCondition = {
      key: 'risk.score',
      operator: 'lessOrEqual',
      value: 30,
    };
    expect(evaluateSingle(condition, mockContext)).toBe(true);
  });
});

// =============================================================================
// evaluateSingle Tests - Array Operators
// =============================================================================

describe('evaluateSingle - Array Operators', () => {
  it('should evaluate in operator', () => {
    const condition: FlowCondition = {
      key: 'user.status',
      operator: 'in',
      value: ['active', 'pending'],
    };
    expect(evaluateSingle(condition, mockContext)).toBe(true);

    const falseCondition: FlowCondition = {
      key: 'user.status',
      operator: 'in',
      value: ['disabled', 'banned'],
    };
    expect(evaluateSingle(falseCondition, mockContext)).toBe(false);
  });

  it('should evaluate notIn operator', () => {
    const condition: FlowCondition = {
      key: 'user.status',
      operator: 'notIn',
      value: ['disabled', 'banned'],
    };
    expect(evaluateSingle(condition, mockContext)).toBe(true);
  });

  it('should evaluate contains for array', () => {
    const condition: FlowCondition = {
      key: 'user.roles',
      operator: 'contains',
      value: 'admin',
    };
    expect(evaluateSingle(condition, mockContext)).toBe(true);
  });
});

// =============================================================================
// evaluateSingle Tests - Existence Operators
// =============================================================================

describe('evaluateSingle - Existence Operators', () => {
  it('should evaluate exists operator', () => {
    const condition: FlowCondition = {
      key: 'user.email',
      operator: 'exists',
    };
    expect(evaluateSingle(condition, mockContext)).toBe(true);

    const falseCondition: FlowCondition = {
      key: 'user.nonExistent',
      operator: 'exists',
    };
    expect(evaluateSingle(falseCondition, mockContext)).toBe(false);
  });

  it('should evaluate notExists operator', () => {
    const condition: FlowCondition = {
      key: 'user.nonExistent',
      operator: 'notExists',
    };
    expect(evaluateSingle(condition, mockContext)).toBe(true);

    const falseCondition: FlowCondition = {
      key: 'user.email',
      operator: 'notExists',
    };
    expect(evaluateSingle(falseCondition, mockContext)).toBe(false);
  });
});

// =============================================================================
// evaluateSingle Tests - Boolean Operators
// =============================================================================

describe('evaluateSingle - Boolean Operators', () => {
  it('should evaluate isTrue operator', () => {
    const condition: FlowCondition = {
      key: 'user.verifiedEmail',
      operator: 'isTrue',
    };
    expect(evaluateSingle(condition, mockContext)).toBe(true);

    const falseCondition: FlowCondition = {
      key: 'user.verifiedPhone',
      operator: 'isTrue',
    };
    expect(evaluateSingle(falseCondition, mockContext)).toBe(false);
  });

  it('should evaluate isFalse operator', () => {
    const condition: FlowCondition = {
      key: 'user.verifiedPhone',
      operator: 'isFalse',
    };
    expect(evaluateSingle(condition, mockContext)).toBe(true);

    const falseCondition: FlowCondition = {
      key: 'user.verifiedEmail',
      operator: 'isFalse',
    };
    expect(evaluateSingle(falseCondition, mockContext)).toBe(false);
  });
});

// =============================================================================
// evaluateGroup Tests - AND/OR Logic
// =============================================================================

describe('evaluateGroup - AND Logic', () => {
  it('should evaluate AND group with all true conditions', () => {
    const group: ConditionGroup = {
      logic: 'and',
      conditions: [
        { key: 'user.verifiedEmail', operator: 'isTrue' },
        { key: 'user.status', operator: 'equals', value: 'active' },
        { key: 'risk.score', operator: 'lessThan', value: 50 },
      ],
    };
    expect(evaluateGroup(group, mockContext, 0)).toBe(true);
  });

  it('should evaluate AND group with one false condition', () => {
    const group: ConditionGroup = {
      logic: 'and',
      conditions: [
        { key: 'user.verifiedEmail', operator: 'isTrue' },
        { key: 'user.status', operator: 'equals', value: 'disabled' }, // false
        { key: 'risk.score', operator: 'lessThan', value: 50 },
      ],
    };
    expect(evaluateGroup(group, mockContext, 0)).toBe(false);
  });

  it('should evaluate empty AND group as true', () => {
    const group: ConditionGroup = {
      logic: 'and',
      conditions: [],
    };
    expect(evaluateGroup(group, mockContext, 0)).toBe(true);
  });
});

describe('evaluateGroup - OR Logic', () => {
  it('should evaluate OR group with at least one true condition', () => {
    const group: ConditionGroup = {
      logic: 'or',
      conditions: [
        { key: 'user.status', operator: 'equals', value: 'disabled' }, // false
        { key: 'user.verifiedEmail', operator: 'isTrue' }, // true
        { key: 'risk.score', operator: 'greaterThan', value: 100 }, // false
      ],
    };
    expect(evaluateGroup(group, mockContext, 0)).toBe(true);
  });

  it('should evaluate OR group with all false conditions', () => {
    const group: ConditionGroup = {
      logic: 'or',
      conditions: [
        { key: 'user.status', operator: 'equals', value: 'disabled' },
        { key: 'user.verifiedPhone', operator: 'isTrue' },
        { key: 'risk.score', operator: 'greaterThan', value: 100 },
      ],
    };
    expect(evaluateGroup(group, mockContext, 0)).toBe(false);
  });

  it('should evaluate empty OR group as true', () => {
    const group: ConditionGroup = {
      logic: 'or',
      conditions: [],
    };
    expect(evaluateGroup(group, mockContext, 0)).toBe(true);
  });
});

// =============================================================================
// evaluate Tests - Nested Conditions
// =============================================================================

describe('evaluate - Nested Conditions', () => {
  it('should evaluate nested AND within OR', () => {
    const condition: ConditionGroup = {
      logic: 'or',
      conditions: [
        {
          logic: 'and',
          conditions: [
            { key: 'user.status', operator: 'equals', value: 'active' },
            { key: 'user.verifiedEmail', operator: 'isTrue' },
          ],
        },
        { key: 'user.customAttributes.role', operator: 'equals', value: 'superadmin' },
      ],
    };
    expect(evaluate(condition, mockContext)).toBe(true);
  });

  it('should evaluate nested OR within AND', () => {
    const condition: ConditionGroup = {
      logic: 'and',
      conditions: [
        {
          logic: 'or',
          conditions: [
            { key: 'user.hasPassword', operator: 'isTrue' },
            { key: 'user.hasWebAuthn', operator: 'isTrue' },
          ],
        },
        { key: 'user.status', operator: 'equals', value: 'active' },
      ],
    };
    expect(evaluate(condition, mockContext)).toBe(true);
  });

  it('should evaluate deeply nested conditions', () => {
    const condition: ConditionGroup = {
      logic: 'and',
      conditions: [
        {
          logic: 'or',
          conditions: [
            {
              logic: 'and',
              conditions: [
                { key: 'user.verifiedEmail', operator: 'isTrue' },
                { key: 'user.hasPassword', operator: 'isTrue' },
              ],
            },
            { key: 'user.hasWebAuthn', operator: 'isTrue' },
          ],
        },
        { key: 'risk.score', operator: 'lessThan', value: 50 },
      ],
    };
    expect(evaluate(condition, mockContext)).toBe(true);
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('Edge Cases', () => {
  it('should handle invalid regex gracefully', () => {
    const condition: FlowCondition = {
      key: 'user.email',
      operator: 'matches',
      value: '[invalid(regex',
    };
    expect(evaluateSingle(condition, mockContext)).toBe(false);
  });

  it('should handle type mismatches gracefully', () => {
    const condition: FlowCondition = {
      key: 'user.email', // string
      operator: 'greaterThan', // number operator
      value: 10,
    };
    expect(evaluateSingle(condition, mockContext)).toBe(false);
  });

  it('should handle null/undefined values', () => {
    const contextWithNull: FlowRuntimeContext = {
      user: {
        email: undefined,
      },
    };

    const condition: FlowCondition = {
      key: 'user.email',
      operator: 'notExists',
    };
    expect(evaluateSingle(condition, contextWithNull)).toBe(true);
  });
});
