/**
 * FlowCompiler - ユニットテスト
 *
 * Decisionノードのコンパイル検証、遷移マップのpriority順確認、sourceHandleの保持確認
 */

import { describe, it, expect } from 'vitest';
import { FlowCompilerService } from './flow-compiler.js';
import type {
  GraphDefinition,
  DecisionNodeConfig,
  SwitchNodeConfig,
} from './types.js';

// =============================================================================
// Test Data
// =============================================================================

const mockDecisionFlowGraph: GraphDefinition = {
  id: 'test-decision-flow',
  flowVersion: '1.0.0',
  name: 'Test Decision Flow',
  description: 'Test flow with decision node',
  profileId: 'core.human-basic-login' as any,
  nodes: [
    {
      id: 'start',
      type: 'start',
      position: { x: 0, y: 0 },
      data: {
        label: 'Start',
        intent: 'core.flow_start' as any,
        capabilities: [],
        config: {},
      },
    },
    {
      id: 'decision_1',
      type: 'decision',
      position: { x: 100, y: 0 },
      data: {
        label: 'User Status Decision',
        intent: 'core.decision' as any,
        capabilities: [],
        config: {
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
        } as any,
      },
    },
    {
      id: 'high_risk_action',
      type: 'error',
      position: { x: 200, y: -100 },
      data: {
        label: 'High Risk Block',
        intent: 'core.error' as any,
        capabilities: [],
        config: {},
      },
    },
    {
      id: 'medium_risk_action',
      type: 'mfa',
      position: { x: 200, y: 0 },
      data: {
        label: 'MFA Challenge',
        intent: 'core.mfa_verify' as any,
        capabilities: [],
        config: {},
      },
    },
    {
      id: 'low_risk_action',
      type: 'end',
      position: { x: 200, y: 100 },
      data: {
        label: 'Success',
        intent: 'core.flow_end' as any,
        capabilities: [],
        config: {},
      },
    },
    {
      id: 'default_action',
      type: 'end',
      position: { x: 200, y: 200 },
      data: {
        label: 'Default End',
        intent: 'core.flow_end' as any,
        capabilities: [],
        config: {},
      },
    },
  ],
  edges: [
    {
      id: 'e1',
      source: 'start',
      target: 'decision_1',
      type: 'success',
    },
    {
      id: 'e2',
      source: 'decision_1',
      target: 'high_risk_action',
      sourceHandle: 'branch_high_risk',
      type: 'conditional',
    },
    {
      id: 'e3',
      source: 'decision_1',
      target: 'medium_risk_action',
      sourceHandle: 'branch_medium_risk',
      type: 'conditional',
    },
    {
      id: 'e4',
      source: 'decision_1',
      target: 'low_risk_action',
      sourceHandle: 'branch_low_risk',
      type: 'conditional',
    },
    {
      id: 'e5',
      source: 'decision_1',
      target: 'default_action',
      sourceHandle: 'branch_default',
      type: 'conditional',
    },
  ],
  metadata: {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
};

const mockSwitchFlowGraph: GraphDefinition = {
  id: 'test-switch-flow',
  flowVersion: '1.0.0',
  name: 'Test Switch Flow',
  description: 'Test flow with switch node',
  profileId: 'core.human-basic-login' as any,
  nodes: [
    {
      id: 'start',
      type: 'start',
      position: { x: 0, y: 0 },
      data: {
        label: 'Start',
        intent: 'core.flow_start' as any,
        capabilities: [],
        config: {},
      },
    },
    {
      id: 'switch_1',
      type: 'switch',
      position: { x: 100, y: 0 },
      data: {
        label: 'Country Switch',
        intent: 'core.decision' as any,
        capabilities: [],
        config: {
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
            {
              id: 'case_asia',
              label: 'Asia',
              values: ['JP', 'CN', 'KR'],
            },
          ],
          defaultCase: 'case_other',
        } as any,
      },
    },
    {
      id: 'us_action',
      type: 'end',
      position: { x: 200, y: -100 },
      data: {
        label: 'US Flow',
        intent: 'core.flow_end' as any,
        capabilities: [],
        config: {},
      },
    },
    {
      id: 'eu_action',
      type: 'end',
      position: { x: 200, y: 0 },
      data: {
        label: 'EU Flow',
        intent: 'core.flow_end' as any,
        capabilities: [],
        config: {},
      },
    },
    {
      id: 'asia_action',
      type: 'end',
      position: { x: 200, y: 100 },
      data: {
        label: 'Asia Flow',
        intent: 'core.flow_end' as any,
        capabilities: [],
        config: {},
      },
    },
    {
      id: 'other_action',
      type: 'end',
      position: { x: 200, y: 200 },
      data: {
        label: 'Other Flow',
        intent: 'core.flow_end' as any,
        capabilities: [],
        config: {},
      },
    },
  ],
  edges: [
    {
      id: 'e1',
      source: 'start',
      target: 'switch_1',
      type: 'success',
    },
    {
      id: 'e2',
      source: 'switch_1',
      target: 'us_action',
      sourceHandle: 'case_us',
      type: 'conditional',
    },
    {
      id: 'e3',
      source: 'switch_1',
      target: 'eu_action',
      sourceHandle: 'case_eu',
      type: 'conditional',
    },
    {
      id: 'e4',
      source: 'switch_1',
      target: 'asia_action',
      sourceHandle: 'case_asia',
      type: 'conditional',
    },
    {
      id: 'e5',
      source: 'switch_1',
      target: 'other_action',
      sourceHandle: 'case_other',
      type: 'conditional',
    },
  ],
  metadata: {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
};

// =============================================================================
// FlowCompiler Tests
// =============================================================================

describe('FlowCompiler - Decision Node', () => {
  it('should compile decision node with decisionConfig', () => {
    const compiler = new FlowCompilerService();
    const plan = compiler.compile(mockDecisionFlowGraph);

    const decisionNode = plan.nodes.get('decision_1');
    expect(decisionNode).toBeDefined();
    expect(decisionNode?.type).toBe('decision');
    expect(decisionNode?.decisionConfig).toBeDefined();

    const config = decisionNode?.decisionConfig as DecisionNodeConfig;
    expect(config.branches).toHaveLength(3);
    expect(config.branches[0].id).toBe('branch_high_risk');
    expect(config.branches[0].priority).toBe(1);
    expect(config.defaultBranch).toBe('branch_default');
  });

  it('should preserve sourceHandle in transitions', () => {
    const compiler = new FlowCompilerService();
    const plan = compiler.compile(mockDecisionFlowGraph);

    const transitions = plan.transitions.get('decision_1');
    expect(transitions).toBeDefined();
    expect(transitions?.length).toBeGreaterThan(0);

    const highRiskTransition = transitions?.find(
      (t) => t.sourceHandle === 'branch_high_risk'
    );
    expect(highRiskTransition).toBeDefined();
    expect(highRiskTransition?.targetNodeId).toBe('high_risk_action');
  });

  it('should sort transitions by priority', () => {
    const compiler = new FlowCompilerService();
    const plan = compiler.compile(mockDecisionFlowGraph);

    const transitions = plan.transitions.get('decision_1');
    expect(transitions).toBeDefined();

    // priority が設定されているか確認
    const highRiskTransition = transitions?.find(
      (t) => t.sourceHandle === 'branch_high_risk'
    );
    const mediumRiskTransition = transitions?.find(
      (t) => t.sourceHandle === 'branch_medium_risk'
    );
    const lowRiskTransition = transitions?.find(
      (t) => t.sourceHandle === 'branch_low_risk'
    );

    expect(highRiskTransition?.priority).toBe(1);
    expect(mediumRiskTransition?.priority).toBe(2);
    expect(lowRiskTransition?.priority).toBe(3);

    // ソート順を確認（priority順になっているか）
    const prioritizedTransitions = transitions?.filter((t) => t.priority !== undefined);
    if (prioritizedTransitions && prioritizedTransitions.length > 1) {
      for (let i = 0; i < prioritizedTransitions.length - 1; i++) {
        const current = prioritizedTransitions[i].priority!;
        const next = prioritizedTransitions[i + 1].priority!;
        expect(current).toBeLessThanOrEqual(next);
      }
    }
  });
});

describe('FlowCompiler - Switch Node', () => {
  it('should compile switch node with switchConfig', () => {
    const compiler = new FlowCompilerService();
    const plan = compiler.compile(mockSwitchFlowGraph);

    const switchNode = plan.nodes.get('switch_1');
    expect(switchNode).toBeDefined();
    expect(switchNode?.type).toBe('switch');
    expect(switchNode?.decisionConfig).toBeDefined();

    const config = switchNode?.decisionConfig as SwitchNodeConfig;
    expect(config.switchKey).toBe('request.country');
    expect(config.cases).toHaveLength(3);
    expect(config.cases[0].id).toBe('case_us');
    expect(config.cases[0].values).toContain('US');
    expect(config.defaultCase).toBe('case_other');
  });

  it('should preserve sourceHandle for switch cases', () => {
    const compiler = new FlowCompilerService();
    const plan = compiler.compile(mockSwitchFlowGraph);

    const transitions = plan.transitions.get('switch_1');
    expect(transitions).toBeDefined();

    const usTransition = transitions?.find((t) => t.sourceHandle === 'case_us');
    expect(usTransition).toBeDefined();
    expect(usTransition?.targetNodeId).toBe('us_action');

    const euTransition = transitions?.find((t) => t.sourceHandle === 'case_eu');
    expect(euTransition).toBeDefined();
    expect(euTransition?.targetNodeId).toBe('eu_action');
  });
});

describe('FlowCompiler - Backward Compatibility', () => {
  it('should compile regular nodes without decisionConfig', () => {
    const simpleGraph: GraphDefinition = {
      id: 'simple-flow',
      flowVersion: '1.0.0',
      name: 'Simple Flow',
      description: 'Simple flow without decision nodes',
      profileId: 'core.human-basic-login' as any,
      nodes: [
        {
          id: 'start',
          type: 'start',
          position: { x: 0, y: 0 },
          data: {
            label: 'Start',
            intent: 'core.flow_start' as any,
            capabilities: [],
            config: {},
          },
        },
        {
          id: 'login',
          type: 'login',
          position: { x: 100, y: 0 },
          data: {
            label: 'Login',
            intent: 'core.authenticate' as any,
            capabilities: [],
            config: {},
          },
        },
        {
          id: 'end',
          type: 'end',
          position: { x: 200, y: 0 },
          data: {
            label: 'End',
            intent: 'core.flow_end' as any,
            capabilities: [],
            config: {},
          },
        },
      ],
      edges: [
        {
          id: 'e1',
          source: 'start',
          target: 'login',
          type: 'success',
        },
        {
          id: 'e2',
          source: 'login',
          target: 'end',
          type: 'success',
        },
      ],
      metadata: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };

    const compiler = new FlowCompilerService();
    const plan = compiler.compile(simpleGraph);

    const loginNode = plan.nodes.get('login');
    expect(loginNode).toBeDefined();
    expect(loginNode?.decisionConfig).toBeUndefined();
    expect(loginNode?.nextOnSuccess).toBe('end');
  });
});
