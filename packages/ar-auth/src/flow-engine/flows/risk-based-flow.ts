/**
 * Risk-Based Authentication Flow with Switch Node
 *
 * このフローは、リスクスコアレベルに基づいて異なる認証パスに分岐します：
 * - low: 通常ログイン続行
 * - medium: 警告表示
 * - high: 追加認証（MFA）
 * - critical: ブロック
 *
 * @see /private/docs/flow-engine-decision-guide.md
 */

import type { GraphDefinition } from '../types.js';

export const riskBasedFlow: GraphDefinition = {
  id: 'risk-based-flow-v1',
  flowVersion: '1.0.0',
  name: 'Risk-Based Authentication',
  description: 'Adaptive authentication based on risk score levels using Switch node',
  profileId: 'core.human-basic-login' as any,
  nodes: [
    {
      id: 'start',
      type: 'start',
      position: { x: 50, y: 250 },
      data: {
        label: 'Start',
        intent: 'core.flow_start' as any,
        capabilities: [],
        config: {},
      },
    },
    {
      id: 'identifier_input',
      type: 'identifier',
      position: { x: 200, y: 250 },
      data: {
        label: 'Enter Email',
        intent: 'core.identifier_input' as any,
        capabilities: [],
        config: {
          type: 'email',
        },
      },
    },
    {
      id: 'risk_check',
      type: 'check_risk',
      position: { x: 350, y: 250 },
      data: {
        label: 'Risk Assessment',
        intent: 'core.check_risk' as any,
        capabilities: [],
        config: {
          check_factors: ['ip', 'device', 'location', 'behavior'],
        },
      },
    },
    {
      id: 'switch_risk_level',
      type: 'switch',
      position: { x: 550, y: 250 },
      data: {
        label: 'Risk Level Router',
        intent: 'core.decision' as any,
        capabilities: [],
        config: {
          switchKey: 'risk.level',
          cases: [
            {
              id: 'case_low',
              label: 'Low Risk',
              values: ['low', 'none'],
            },
            {
              id: 'case_medium',
              label: 'Medium Risk',
              values: ['medium'],
            },
            {
              id: 'case_high',
              label: 'High Risk',
              values: ['high'],
            },
            {
              id: 'case_critical',
              label: 'Critical/Blocked',
              values: ['critical', 'blocked'],
            },
          ],
          defaultCase: 'case_default',
        } as any,
      },
    },
    // Case 1: Low Risk → Normal Login
    {
      id: 'low_risk_login',
      type: 'login',
      position: { x: 750, y: 50 },
      data: {
        label: 'Normal Login',
        intent: 'core.authenticate' as any,
        capabilities: [],
        config: {
          methods: ['password', 'passkey'],
        },
      },
    },
    {
      id: 'low_risk_success',
      type: 'end',
      position: { x: 950, y: 50 },
      data: {
        label: 'Success',
        intent: 'core.flow_end' as any,
        capabilities: [],
        config: {
          success: true,
          risk_level: 'low',
        },
      },
    },
    // Case 2: Medium Risk → Warning + Login
    {
      id: 'medium_risk_warning',
      type: 'information',
      position: { x: 750, y: 150 },
      data: {
        label: 'Security Warning',
        intent: 'core.display_info' as any,
        capabilities: [],
        config: {
          message: 'Unusual activity detected. Please verify your identity.',
          severity: 'warning',
        },
      },
    },
    {
      id: 'medium_risk_login',
      type: 'login',
      position: { x: 950, y: 150 },
      data: {
        label: 'Login with Verification',
        intent: 'core.authenticate' as any,
        capabilities: [],
        config: {
          methods: ['password', 'passkey'],
          require_verification: true,
        },
      },
    },
    {
      id: 'medium_risk_success',
      type: 'end',
      position: { x: 1150, y: 150 },
      data: {
        label: 'Success',
        intent: 'core.flow_end' as any,
        capabilities: [],
        config: {
          success: true,
          risk_level: 'medium',
        },
      },
    },
    // Case 3: High Risk → MFA Required
    {
      id: 'high_risk_login',
      type: 'login',
      position: { x: 750, y: 250 },
      data: {
        label: 'Primary Login',
        intent: 'core.authenticate' as any,
        capabilities: [],
        config: {
          methods: ['password', 'passkey'],
        },
      },
    },
    {
      id: 'high_risk_mfa',
      type: 'mfa',
      position: { x: 950, y: 250 },
      data: {
        label: 'MFA Required',
        intent: 'core.mfa_verify' as any,
        capabilities: [],
        config: {
          factors: ['totp', 'sms', 'email_otp'],
          required: true,
        },
      },
    },
    {
      id: 'high_risk_success',
      type: 'end',
      position: { x: 1150, y: 250 },
      data: {
        label: 'Success with MFA',
        intent: 'core.flow_end' as any,
        capabilities: [],
        config: {
          success: true,
          risk_level: 'high',
          mfa_verified: true,
        },
      },
    },
    // Case 4: Critical → Blocked
    {
      id: 'critical_block',
      type: 'error',
      position: { x: 750, y: 350 },
      data: {
        label: 'Access Blocked',
        intent: 'core.error' as any,
        capabilities: [],
        config: {
          reason: 'high_risk_blocked',
          allow_retry: false,
          message: 'Your access has been blocked due to security concerns. Please contact support.',
        },
      },
    },
    // Default Case
    {
      id: 'default_error',
      type: 'error',
      position: { x: 750, y: 450 },
      data: {
        label: 'Unknown Risk Level',
        intent: 'core.error' as any,
        capabilities: [],
        config: {
          reason: 'unknown_risk_level',
          allow_retry: true,
        },
      },
    },
  ],
  edges: [
    {
      id: 'e1',
      source: 'start',
      target: 'identifier_input',
      type: 'success',
    },
    {
      id: 'e2',
      source: 'identifier_input',
      target: 'risk_check',
      type: 'success',
    },
    {
      id: 'e3',
      source: 'risk_check',
      target: 'switch_risk_level',
      type: 'success',
    },
    // Switch cases
    {
      id: 'e4',
      source: 'switch_risk_level',
      target: 'low_risk_login',
      sourceHandle: 'case_low',
      type: 'conditional',
      data: {
        label: 'Low',
      },
    },
    {
      id: 'e5',
      source: 'switch_risk_level',
      target: 'medium_risk_warning',
      sourceHandle: 'case_medium',
      type: 'conditional',
      data: {
        label: 'Medium',
      },
    },
    {
      id: 'e6',
      source: 'switch_risk_level',
      target: 'high_risk_login',
      sourceHandle: 'case_high',
      type: 'conditional',
      data: {
        label: 'High',
      },
    },
    {
      id: 'e7',
      source: 'switch_risk_level',
      target: 'critical_block',
      sourceHandle: 'case_critical',
      type: 'conditional',
      data: {
        label: 'Critical',
      },
    },
    {
      id: 'e8',
      source: 'switch_risk_level',
      target: 'default_error',
      sourceHandle: 'case_default',
      type: 'conditional',
      data: {
        label: 'Default',
      },
    },
    // Low risk path
    {
      id: 'e9',
      source: 'low_risk_login',
      target: 'low_risk_success',
      type: 'success',
    },
    // Medium risk path
    {
      id: 'e10',
      source: 'medium_risk_warning',
      target: 'medium_risk_login',
      type: 'success',
    },
    {
      id: 'e11',
      source: 'medium_risk_login',
      target: 'medium_risk_success',
      type: 'success',
    },
    // High risk path
    {
      id: 'e12',
      source: 'high_risk_login',
      target: 'high_risk_mfa',
      type: 'success',
    },
    {
      id: 'e13',
      source: 'high_risk_mfa',
      target: 'high_risk_success',
      type: 'success',
    },
  ],
  metadata: {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: 'system',
  },
};
