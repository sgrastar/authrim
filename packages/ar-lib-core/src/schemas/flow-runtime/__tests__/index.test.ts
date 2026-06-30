import { describe, expect, it } from 'vitest';

import {
  evaluateFlowConditionRows,
  FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION,
  getFlowNodeDefinition,
  isCustomFlowNodeType,
  isStandardFlowNodeType,
  sanitizeImportedFlowContract,
  validateFlowEditorState,
  validateFlowRuntimeContractPackage,
  type FlowConditionConfig,
} from '../index';

describe('flow runtime schema helpers', () => {
  it('recognizes standard and reserved custom node types', () => {
    expect(FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION).toBe('authrim.login_ui.contract.v1');
    expect(isStandardFlowNodeType('authentication')).toBe(true);
    expect(isStandardFlowNodeType('custom:plugin/node')).toBe(false);
    expect(isCustomFlowNodeType('custom:plugin/node')).toBe(true);
    expect(getFlowNodeDefinition('consent')?.runtime_component).toBe('consent_policy');
  });

  it('removes runtime-only security and one-time fields from imported JSON', () => {
    const sanitized = sanitizeImportedFlowContract({
      schema_version: FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION,
      mode: 'runtime',
      interaction_id: 'li_123',
      expires_at: '2026-06-30T12:00:00Z',
      runtime: {
        submit: {
          endpoint: '/api/v1/login/interactions/li_123/submit',
        },
        security: {
          csrf_token: 'csrf',
          nonce: 'nonce',
          contract_hash: 'sha256-old',
          signature: 'hmac-old',
        },
        csrfToken: 'camel-csrf',
        accessToken: 'camel-access',
        token: 'generic-token',
        ui: {
          steps: [
            {
              id: 'step-1',
              access_token: 'secret',
              content: {
                label: 'Keep me',
                refresh_token: 'secret',
              },
            },
          ],
        },
      },
      editor: {
        nodes: [],
        edges: [],
      },
    });

    expect(sanitized).toEqual({
      schema_version: FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION,
      mode: 'runtime',
      runtime: {
        ui: {
          steps: [
            {
              id: 'step-1',
              content: {
                label: 'Keep me',
              },
            },
          ],
        },
      },
      editor: {
        nodes: [],
        edges: [],
      },
    });
  });

  it('validates the shared runtime contract package shape', () => {
    expect(
      validateFlowRuntimeContractPackage({
        schema_version: FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION,
        mode: 'preview',
        runtime: {
          flow_kind: 'login',
          ui: {
            steps: [
              {
                id: 'entry-step',
                source_node_id: 'entry',
                component: 'interaction_context',
                render: false,
              },
            ],
          },
        },
        editor: {
          nodes: [
            {
              id: 'entry',
              type: 'entry',
            },
            {
              id: 'complete',
              type: 'complete',
            },
          ],
          edges: [
            {
              id: 'edge-1',
              source: 'entry',
              target: 'complete',
            },
          ],
        },
      })
    ).toEqual([]);

    expect(
      validateFlowRuntimeContractPackage({
        schema_version: 'old',
        mode: 'runtime',
        runtime: {
          ui: {
            steps: [
              {
                id: 'broken',
                component: 'completion',
              },
            ],
          },
        },
      }).map((issue) => issue.code)
    ).toEqual(
      expect.arrayContaining([
        'invalid_schema_version',
        'missing_flow_kind',
        'missing_runtime_source_node',
        'missing_runtime_render_flag',
      ])
    );
  });

  it('reports publish-blocking graph and node registry issues', () => {
    const issues = validateFlowEditorState(
      {
        nodes: [
          {
            id: 'entry',
            type: 'entry',
          },
          {
            id: 'auth',
            type: 'authentication',
            config: {},
          },
          {
            id: 'custom',
            type: 'custom:plugin/node',
          },
        ],
        edges: [
          {
            id: 'edge-1',
            source: 'entry',
            target: 'missing',
          },
          {
            id: 'edge-2',
            source: 'entry',
            source_handle: 'not-supported',
            target: 'auth',
          },
        ],
      },
      { for_publish: true }
    );

    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'missing_complete_node',
        'missing_required_node_config',
        'unsupported_custom_node',
        'missing_node_reference',
        'invalid_output_handle',
      ])
    );
    expect(issues.every((issue) => issue.level === 'error')).toBe(true);
  });

  it('rejects edges that directly connect incompatible completion blocks', () => {
    const issues = validateFlowEditorState(
      {
        nodes: [
          { id: 'entry', type: 'entry' },
          {
            id: 'oidc-consent',
            type: 'consent',
            config: {
              consent_policy_ref: 'oidc-policy',
              completion_block: {
                id: 'oidc-authorization-completion',
                protocol: 'oidc',
                purpose: 'authorization',
                role: 'consent',
              },
            },
          },
          {
            id: 'saml-complete',
            type: 'complete',
            config: {
              completion_block: {
                id: 'saml-attribute-release-completion',
                protocol: 'saml',
                purpose: 'attribute_release',
                role: 'output',
              },
            },
          },
        ],
        edges: [
          { id: 'edge-entry-consent', source: 'entry', target: 'oidc-consent' },
          {
            id: 'edge-consent-complete',
            source: 'oidc-consent',
            source_handle: 'accepted',
            target: 'saml-complete',
          },
        ],
      },
      { for_publish: true }
    );

    expect(issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'completion_block_protocol_mismatch',
        'completion_block_purpose_mismatch',
      ])
    );
  });

  it('evaluates condition rows with deterministic first-match semantics', async () => {
    const config: FlowConditionConfig = {
      rows: [
        {
          id: 'admins',
          condition: {
            type: 'user.role',
            value: 'admin',
          },
          output_handle: 'admin_path',
        },
        {
          id: 'authenticated',
          condition: {
            type: 'authenticated',
            value: true,
          },
          output_handle: 'authenticated_path',
        },
      ],
      otherwise: {
        output_handle: 'guest_path',
      },
    };

    await expect(
      evaluateFlowConditionRows(config, {
        authenticated: true,
        user: {
          roles: ['admin'],
        },
      })
    ).resolves.toMatchObject({
      matched: true,
      output_handle: 'admin_path',
    });

    await expect(
      evaluateFlowConditionRows(config, {
        authenticated: true,
        user: {
          roles: ['member'],
        },
      })
    ).resolves.toMatchObject({
      matched: true,
      output_handle: 'authenticated_path',
    });

    await expect(evaluateFlowConditionRows(config, { authenticated: false })).resolves.toEqual({
      matched: false,
      output_handle: 'guest_path',
      terminal_error: undefined,
    });
  });

  it('uses policy and organization resolvers only when a condition requires them', async () => {
    const config: FlowConditionConfig = {
      rows: [
        {
          id: 'policy',
          condition: {
            type: 'policy_rule',
            policy_ref: {
              id: 'policy-1',
            },
            match: 'allow',
          },
          output_handle: 'allowed',
        },
      ],
      otherwise: {
        terminal_error: {
          error: 'not_allowed',
        },
      },
    };

    await expect(evaluateFlowConditionRows(config, {}, {})).resolves.toEqual({
      matched: false,
      output_handle: undefined,
      terminal_error: {
        error: 'not_allowed',
      },
    });

    await expect(
      evaluateFlowConditionRows(config, {}, { evaluate_policy: () => true })
    ).resolves.toMatchObject({
      matched: true,
      output_handle: 'allowed',
    });

    await expect(
      evaluateFlowConditionRows(
        config,
        {},
        {
          evaluate_policy: () => {
            throw new Error('down');
          },
        }
      )
    ).resolves.toEqual({
      matched: false,
      output_handle: undefined,
      terminal_error: {
        error: 'not_allowed',
      },
    });
  });
});
