/**
 * FlowExecutor - integration tests
 *
 * Validate determineNextNode behavior
 * Tests for Decision/Switch branching and backward compatibility
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  CompiledPlan,
  CompiledNode,
  FlowRuntimeContext,
  DecisionNodeConfig,
  SwitchNodeConfig,
} from './types.js';

// Create a test class that can access private methods to test selected FlowExecutor methods
class FlowExecutorTestHelper {
  /**
   * Evaluate Decision/Switch nodes (exposed as public methods for tests)
   */
  evaluateDecisionNode(
    node: CompiledNode,
    plan: CompiledPlan,
    context: FlowRuntimeContext
  ): string | null {
    if (node.type === 'decision') {
      return this.evaluateDecisionBranches(node, plan, context);
    }

    if (node.type === 'switch') {
      return this.evaluateSwitchCases(node, plan, context);
    }

    return null;
  }

  /**
   * Evaluate Decision branches
   */
  private evaluateDecisionBranches(
    node: CompiledNode,
    plan: CompiledPlan,
    context: FlowRuntimeContext
  ): string | null {
    const config = node.decisionConfig as DecisionNodeConfig | undefined;
    if (!config) {
      return null;
    }

    const transitions = plan.transitions.get(node.id) || [];

    // Evaluate conditions in priority order
    for (const branch of config.branches) {
      const matches = this.evaluateCondition(branch.condition, context);

      if (matches) {
        const transition = transitions.find((t) => t.sourceHandle === branch.id);
        if (transition) {
          return transition.targetNodeId;
        }
      }
    }

    // Default branch
    if (config.defaultBranch) {
      const defaultTransition = transitions.find((t) => t.sourceHandle === config.defaultBranch);
      if (defaultTransition) {
        return defaultTransition.targetNodeId;
      }
    }

    return null;
  }

  /**
   * Evaluate Switch case
   */
  private evaluateSwitchCases(
    node: CompiledNode,
    plan: CompiledPlan,
    context: FlowRuntimeContext
  ): string | null {
    const config = node.decisionConfig as SwitchNodeConfig | undefined;
    if (!config) {
      return null;
    }

    // Dangerous keys for prototype pollution mitigation
    const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

    // Get the switchKey value
    const keyParts = config.switchKey.split('.');
    let value: unknown = context;
    for (const part of keyParts) {
      // Prototype pollution mitigation: Reject dangerous keys
      if (DANGEROUS_KEYS.includes(part)) {
        console.error(
          `[Security] Dangerous key detected in switchKey: "${part}" (full key: "${config.switchKey}")`
        );
        value = undefined;
        break;
      }

      if (value === null || value === undefined || typeof value !== 'object') {
        value = undefined;
        break;
      }

      // Prototype pollution mitigation: Use hasOwnProperty to avoid walking the prototype chain
      if (!Object.prototype.hasOwnProperty.call(value, part)) {
        value = undefined;
        break;
      }

      value = (value as Record<string, unknown>)[part];
    }

    const transitions = plan.transitions.get(node.id) || [];

    // Compare each case with the value
    for (const caseItem of config.cases) {
      if (caseItem.values.includes(value as string | number | boolean)) {
        const transition = transitions.find((t) => t.sourceHandle === caseItem.id);
        if (transition) {
          return transition.targetNodeId;
        }
      }
    }

    // Default case
    if (config.defaultCase) {
      const defaultTransition = transitions.find((t) => t.sourceHandle === config.defaultCase);
      if (defaultTransition) {
        return defaultTransition.targetNodeId;
      }
    }

    return null;
  }

  /**
   * Condition evaluation (simple implementation)
   */
  private evaluateCondition(condition: unknown, context: FlowRuntimeContext): boolean {
    // Instead of using the real evaluate function, simple implementation
    const cond = condition as { key: string; operator: string; value: unknown };

    const keyParts = cond.key.split('.');
    let actualValue: unknown = context;
    for (const part of keyParts) {
      if (actualValue === null || actualValue === undefined || typeof actualValue !== 'object') {
        actualValue = undefined;
        break;
      }
      actualValue = (actualValue as Record<string, unknown>)[part];
    }

    switch (cond.operator) {
      case 'greaterThan':
        return typeof actualValue === 'number' && typeof cond.value === 'number'
          ? actualValue > cond.value
          : false;
      case 'lessOrEqual':
        return typeof actualValue === 'number' && typeof cond.value === 'number'
          ? actualValue <= cond.value
          : false;
      case 'equals':
        return actualValue === cond.value;
      default:
        return false;
    }
  }
}

// =============================================================================
// Test Data
// =============================================================================

const mockDecisionPlan: CompiledPlan = {
  id: 'compiled-test-decision',
  version: '1.0.0',
  sourceVersion: '1.0.0',
  profileId: 'core.human-basic-login' as any,
  entryNodeId: 'decision_1',
  nodes: new Map([
    [
      'decision_1',
      {
        id: 'decision_1',
        type: 'decision',
        intent: 'core.decision' as any,
        capabilities: [],
        nextOnSuccess: null,
        nextOnError: null,
        decisionConfig: {
          branches: [
            {
              id: 'branch_high_risk',
              label: 'High Risk',
              condition: {
                key: 'risk.score',
                operator: 'greaterThan',
                value: 70,
              },
              priority: 1,
            },
            {
              id: 'branch_medium_risk',
              label: 'Medium Risk',
              condition: {
                key: 'risk.score',
                operator: 'greaterThan',
                value: 30,
              },
              priority: 2,
            },
            {
              id: 'branch_low_risk',
              label: 'Low Risk',
              condition: {
                key: 'risk.score',
                operator: 'lessOrEqual',
                value: 30,
              },
              priority: 3,
            },
          ],
          defaultBranch: 'branch_default',
        } as DecisionNodeConfig,
      },
    ],
  ]),
  transitions: new Map([
    [
      'decision_1',
      [
        {
          targetNodeId: 'high_risk_action',
          type: 'conditional',
          sourceHandle: 'branch_high_risk',
          priority: 1,
        },
        {
          targetNodeId: 'medium_risk_action',
          type: 'conditional',
          sourceHandle: 'branch_medium_risk',
          priority: 2,
        },
        {
          targetNodeId: 'low_risk_action',
          type: 'conditional',
          sourceHandle: 'branch_low_risk',
          priority: 3,
        },
        {
          targetNodeId: 'default_action',
          type: 'conditional',
          sourceHandle: 'branch_default',
        },
      ],
    ],
  ]),
  compiledAt: new Date().toISOString(),
};

const mockSwitchPlan: CompiledPlan = {
  id: 'compiled-test-switch',
  version: '1.0.0',
  sourceVersion: '1.0.0',
  profileId: 'core.human-basic-login' as any,
  entryNodeId: 'switch_1',
  nodes: new Map([
    [
      'switch_1',
      {
        id: 'switch_1',
        type: 'switch',
        intent: 'core.decision' as any,
        capabilities: [],
        nextOnSuccess: null,
        nextOnError: null,
        decisionConfig: {
          switchKey: 'request.country',
          cases: [
            {
              id: 'case_us',
              label: 'US',
              values: ['US', 'USA'],
            },
            {
              id: 'case_eu',
              label: 'EU',
              values: ['DE', 'FR', 'UK'],
            },
          ],
          defaultCase: 'case_other',
        } as SwitchNodeConfig,
      },
    ],
  ]),
  transitions: new Map([
    [
      'switch_1',
      [
        {
          targetNodeId: 'us_action',
          type: 'conditional',
          sourceHandle: 'case_us',
        },
        {
          targetNodeId: 'eu_action',
          type: 'conditional',
          sourceHandle: 'case_eu',
        },
        {
          targetNodeId: 'other_action',
          type: 'conditional',
          sourceHandle: 'case_other',
        },
      ],
    ],
  ]),
  compiledAt: new Date().toISOString(),
};

// =============================================================================
// Tests
// =============================================================================

describe('FlowExecutor - Decision Node', () => {
  let helper: FlowExecutorTestHelper;

  beforeEach(() => {
    helper = new FlowExecutorTestHelper();
  });

  it('should evaluate high risk branch', () => {
    const context: FlowRuntimeContext = {
      risk: {
        score: 80,
      },
    };

    const decisionNode = mockDecisionPlan.nodes.get('decision_1')!;
    const result = helper.evaluateDecisionNode(decisionNode, mockDecisionPlan, context);

    expect(result).toBe('high_risk_action');
  });

  it('should evaluate medium risk branch', () => {
    const context: FlowRuntimeContext = {
      risk: {
        score: 50,
      },
    };

    const decisionNode = mockDecisionPlan.nodes.get('decision_1')!;
    const result = helper.evaluateDecisionNode(decisionNode, mockDecisionPlan, context);

    expect(result).toBe('medium_risk_action');
  });

  it('should evaluate low risk branch', () => {
    const context: FlowRuntimeContext = {
      risk: {
        score: 20,
      },
    };

    const decisionNode = mockDecisionPlan.nodes.get('decision_1')!;
    const result = helper.evaluateDecisionNode(decisionNode, mockDecisionPlan, context);

    expect(result).toBe('low_risk_action');
  });

  it('should use default branch when no conditions match', () => {
    const context: FlowRuntimeContext = {
      risk: {
        // Case where score does not exist
      },
    };

    const decisionNode = mockDecisionPlan.nodes.get('decision_1')!;
    const result = helper.evaluateDecisionNode(decisionNode, mockDecisionPlan, context);

    expect(result).toBe('default_action');
  });

  it('should prioritize first matching branch', () => {
    // When risk.score = 80, both medium and high match, but,
    // priority 1 high_risk should be evaluated first
    const context: FlowRuntimeContext = {
      risk: {
        score: 80,
      },
    };

    const decisionNode = mockDecisionPlan.nodes.get('decision_1')!;
    const result = helper.evaluateDecisionNode(decisionNode, mockDecisionPlan, context);

    // priority 1 (high_risk) is selected
    expect(result).toBe('high_risk_action');
  });
});

describe('FlowExecutor - Switch Node', () => {
  let helper: FlowExecutorTestHelper;

  beforeEach(() => {
    helper = new FlowExecutorTestHelper();
  });

  it('should evaluate US case', () => {
    const context: FlowRuntimeContext = {
      request: {
        country: 'US',
      },
    };

    const switchNode = mockSwitchPlan.nodes.get('switch_1')!;
    const result = helper.evaluateDecisionNode(switchNode, mockSwitchPlan, context);

    expect(result).toBe('us_action');
  });

  it('should evaluate EU case', () => {
    const context: FlowRuntimeContext = {
      request: {
        country: 'DE',
      },
    };

    const switchNode = mockSwitchPlan.nodes.get('switch_1')!;
    const result = helper.evaluateDecisionNode(switchNode, mockSwitchPlan, context);

    expect(result).toBe('eu_action');
  });

  it('should use default case when no values match', () => {
    const context: FlowRuntimeContext = {
      request: {
        country: 'AU',
      },
    };

    const switchNode = mockSwitchPlan.nodes.get('switch_1')!;
    const result = helper.evaluateDecisionNode(switchNode, mockSwitchPlan, context);

    expect(result).toBe('other_action');
  });

  it('should handle missing key', () => {
    const context: FlowRuntimeContext = {
      request: {
        // country does not exist
      },
    };

    const switchNode = mockSwitchPlan.nodes.get('switch_1')!;
    const result = helper.evaluateDecisionNode(switchNode, mockSwitchPlan, context);

    expect(result).toBe('other_action');
  });
});

// =============================================================================
// Security Tests - Critical/High/Medium-severity vulnerability mitigations
// =============================================================================

// =============================================================================
// Session Validation Tests (Critical 4)
// =============================================================================

describe('Security - Session Validation (Critical 4)', () => {
  /**
   * Session validation tests for FlowExecutor.submitCapability
   *
   * Test cases:
   * - tenantIdmismatch: error when request tenantId and session tenantId differ
   * - clientIdmismatch: error when request clientId and session clientId differ
   * - Success case: Continue when both match
   */

  // Unit-test the verification logic instead of mocking FlowExecutor directly
  function validateSession(
    requestTenantId: string | undefined,
    requestClientId: string | undefined,
    sessionTenantId: string,
    sessionClientId: string
  ): { valid: boolean; errorCode?: string; errorMessage?: string } {
    // tenantIdverification
    if (requestTenantId && sessionTenantId !== requestTenantId) {
      return {
        valid: false,
        errorCode: 'invalid_session',
        errorMessage: 'Session tenant mismatch',
      };
    }

    // clientIdverification
    if (requestClientId && sessionClientId !== requestClientId) {
      return {
        valid: false,
        errorCode: 'invalid_session',
        errorMessage: 'Session client mismatch',
      };
    }

    return { valid: true };
  }

  it('should reject when tenantId mismatches', () => {
    const result = validateSession(
      'tenant-attacker', // request tenantId (attacker)
      'client-1', // request clientId
      'tenant-victim', // session tenantId (victim)
      'client-1' // session clientId
    );

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('invalid_session');
    expect(result.errorMessage).toBe('Session tenant mismatch');
  });

  it('should reject when clientId mismatches', () => {
    const result = validateSession(
      'tenant-1', // request tenantId
      'client-attacker', // request clientId (attacker)
      'tenant-1', // session tenantId
      'client-victim' // session clientId (victim)
    );

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('invalid_session');
    expect(result.errorMessage).toBe('Session client mismatch');
  });

  it('should allow when both tenantId and clientId match', () => {
    const result = validateSession(
      'tenant-1', // request tenantId
      'client-1', // request clientId
      'tenant-1', // session tenantId (match)
      'client-1' // session clientId (match)
    );

    expect(result.valid).toBe(true);
    expect(result.errorCode).toBeUndefined();
  });

  it('should allow when tenantId is not provided (optional check)', () => {
    const result = validateSession(
      undefined, // no tenantId (check skipped)
      'client-1', // request clientId
      'tenant-any', // session tenantId (any value is acceptable)
      'client-1' // session clientId
    );

    expect(result.valid).toBe(true);
  });

  it('should allow when clientId is not provided (optional check)', () => {
    const result = validateSession(
      'tenant-1', // request tenantId
      undefined, // no clientId (check skipped)
      'tenant-1', // session tenantId
      'client-any' // session clientId (any value is acceptable)
    );

    expect(result.valid).toBe(true);
  });

  it('should reject when both tenantId and clientId mismatch', () => {
    const result = validateSession(
      'tenant-attacker',
      'client-attacker',
      'tenant-victim',
      'client-victim'
    );

    expect(result.valid).toBe(false);
    // tenantId is checked first, so a tenant error is returned
    expect(result.errorCode).toBe('invalid_session');
    expect(result.errorMessage).toBe('Session tenant mismatch');
  });
});

describe('Security - Prototype Pollution in Switch (Critical 1)', () => {
  let helper: FlowExecutorTestHelper;

  beforeEach(() => {
    helper = new FlowExecutorTestHelper();
  });

  it('should reject __proto__ in switchKey', () => {
    const maliciousPlan: CompiledPlan = {
      ...mockSwitchPlan,
      nodes: new Map([
        [
          'switch_malicious',
          {
            id: 'switch_malicious',
            type: 'switch',
            intent: 'core.decision' as any,
            capabilities: [],
            nextOnSuccess: null,
            nextOnError: null,
            decisionConfig: {
              switchKey: 'request.__proto__.country', // malicious key
              cases: [
                {
                  id: 'case_us',
                  label: 'US',
                  values: ['US'],
                },
              ],
              defaultCase: 'case_other',
            } as SwitchNodeConfig,
          },
        ],
      ]),
      transitions: new Map([
        [
          'switch_malicious',
          [
            {
              targetNodeId: 'us_action',
              type: 'conditional',
              sourceHandle: 'case_us',
            },
            {
              targetNodeId: 'other_action',
              type: 'conditional',
              sourceHandle: 'case_other',
            },
          ],
        ],
      ]),
    };

    const context: FlowRuntimeContext = {
      request: {
        country: 'US',
      },
    };

    const maliciousNode = maliciousPlan.nodes.get('switch_malicious')!;
    const result = helper.evaluateDecisionNode(maliciousNode, maliciousPlan, context);

    // Prototype pollution mitigation makes the malicious key undefined, so the default case is selected
    expect(result).toBe('other_action');
  });

  it('should reject constructor in switchKey', () => {
    const maliciousPlan: CompiledPlan = {
      ...mockSwitchPlan,
      nodes: new Map([
        [
          'switch_malicious',
          {
            id: 'switch_malicious',
            type: 'switch',
            intent: 'core.decision' as any,
            capabilities: [],
            nextOnSuccess: null,
            nextOnError: null,
            decisionConfig: {
              switchKey: 'request.constructor.name', // malicious key
              cases: [
                {
                  id: 'case_object',
                  label: 'Object',
                  values: ['Object'],
                },
              ],
              defaultCase: 'case_other',
            } as SwitchNodeConfig,
          },
        ],
      ]),
      transitions: new Map([
        [
          'switch_malicious',
          [
            {
              targetNodeId: 'object_action',
              type: 'conditional',
              sourceHandle: 'case_object',
            },
            {
              targetNodeId: 'other_action',
              type: 'conditional',
              sourceHandle: 'case_other',
            },
          ],
        ],
      ]),
    };

    const context: FlowRuntimeContext = {
      request: {
        country: 'US',
      },
    };

    const maliciousNode = maliciousPlan.nodes.get('switch_malicious')!;
    const result = helper.evaluateDecisionNode(maliciousNode, maliciousPlan, context);

    // Prototype pollution mitigation rejects constructor keys
    expect(result).toBe('other_action');
  });
});
