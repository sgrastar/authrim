import { describe, expect, it } from 'vitest';

import {
  evaluateFlowConditionRows,
  FLOW_RUNTIME_CONTRACT_SCHEMA_VERSION,
  getFlowNodeDefinition,
  isCustomFlowNodeType,
  isStandardFlowNodeType,
  sanitizeImportedFlowContract,
  screenAnswerEntriesOf,
  screenAnswersOf,
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

  it('accepts protocol-neutral session check output handles', () => {
    const issues = validateFlowEditorState(
      {
        nodes: [
          { id: 'entry', type: 'entry' },
          { id: 'session-check', type: 'session_check' },
          {
            id: 'authentication',
            type: 'authentication',
            config: {
              authentication_profile_ref: 'default',
              outputs: [{ id: 'passkey', label: 'Passkey' }],
            },
          },
          {
            id: 'complete',
            type: 'complete',
          },
        ],
        edges: [
          {
            id: 'entry:next->session-check',
            source: 'entry',
            source_handle: 'next',
            target: 'session-check',
          },
          {
            id: 'session-check:continue->complete',
            source: 'session-check',
            source_handle: 'continue',
            target: 'complete',
          },
          {
            id: 'session-check:authenticate->authentication',
            source: 'session-check',
            source_handle: 'authenticate',
            target: 'authentication',
          },
          {
            id: 'authentication:passkey->complete',
            source: 'authentication',
            source_handle: 'passkey',
            target: 'complete',
          },
        ],
      },
      { for_publish: true }
    );

    expect(issues.filter((issue) => issue.code === 'invalid_output_handle')).toEqual([]);
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

  it('evaluates explicit OIDC and SAML protocol branches', async () => {
    const config: FlowConditionConfig = {
      rows: ['oidc', 'saml'].map((protocol) => ({
        id: protocol,
        condition: { type: 'protocol', value: protocol },
        output_handle: protocol,
      })),
      otherwise: { terminal_error: { error: 'unsupported_protocol' } },
    };

    for (const protocol of ['oidc', 'saml'] as const) {
      await expect(evaluateFlowConditionRows(config, { protocol })).resolves.toMatchObject({
        matched: true,
        output_handle: protocol,
      });
    }
  });

  it('allows a protocol condition to define only the supported Flow branches', () => {
    const issues = validateFlowEditorState(
      {
        nodes: [
          { id: 'entry', type: 'entry' },
          {
            id: 'protocol',
            type: 'condition',
            config: {
              conditions: {
                rows: [
                  {
                    id: 'oidc',
                    condition: { type: 'protocol', value: 'oidc' },
                    output_handle: 'oidc',
                  },
                ],
                otherwise: { terminal_error: { error: 'unsupported_protocol' } },
              },
            },
          },
          {
            id: 'complete',
            type: 'complete',
            config: { completion_block: { id: 'oidc', protocol: 'oidc' } },
          },
        ],
        edges: [
          { id: 'entry-protocol', source: 'entry', target: 'protocol' },
          {
            id: 'protocol-complete',
            source: 'protocol',
            source_handle: 'oidc',
            target: 'complete',
          },
        ],
      },
      { for_publish: true }
    );

    expect(issues).toEqual([]);
  });

  it('rejects a Direct Auth branch in an SAML/OIDC protocol condition', () => {
    const issues = validateFlowEditorState(
      {
        nodes: [
          { id: 'entry', type: 'entry' },
          {
            id: 'protocol',
            type: 'condition',
            config: {
              conditions: {
                rows: [
                  {
                    id: 'direct',
                    condition: { type: 'protocol', value: 'direct' },
                    output_handle: 'direct',
                  },
                ],
                otherwise: { terminal_error: { error: 'unsupported_protocol' } },
              },
            },
          },
          {
            id: 'complete',
            type: 'complete',
            config: { completion_block: { id: 'direct', protocol: 'direct' } },
          },
        ],
        edges: [
          { id: 'entry-protocol', source: 'entry', target: 'protocol' },
          {
            id: 'protocol-complete',
            source: 'protocol',
            source_handle: 'direct',
            target: 'complete',
          },
        ],
      },
      { for_publish: true }
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_protocol_condition_value' }),
      ])
    );
  });

  it('rejects a protocol branch that reaches another protocol completion', () => {
    const protocolRows = ['oidc', 'saml'].map((protocol) => ({
      id: protocol,
      condition: { type: 'protocol', value: protocol },
      output_handle: protocol,
    }));
    const issues = validateFlowEditorState(
      {
        nodes: [
          { id: 'entry', type: 'entry' },
          {
            id: 'protocol',
            type: 'condition',
            config: {
              conditions: {
                rows: protocolRows,
                otherwise: { terminal_error: { error: 'unsupported_protocol' } },
              },
            },
          },
          {
            id: 'oidc-complete',
            type: 'complete',
            config: { completion_block: { id: 'oidc', protocol: 'oidc' } },
          },
          {
            id: 'saml-complete',
            type: 'complete',
            config: { completion_block: { id: 'saml', protocol: 'saml' } },
          },
        ],
        edges: [
          { id: 'entry-protocol', source: 'entry', target: 'protocol' },
          {
            id: 'protocol-oidc',
            source: 'protocol',
            source_handle: 'oidc',
            target: 'saml-complete',
          },
          {
            id: 'protocol-saml',
            source: 'protocol',
            source_handle: 'saml',
            target: 'saml-complete',
          },
        ],
      },
      { for_publish: true }
    );

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'protocol_condition_completion_mismatch',
          node_id: 'saml-complete',
        }),
      ])
    );
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

describe('screen answer conditions', () => {
  const rowsOf = (condition: Record<string, unknown>): FlowConditionConfig => ({
    rows: [{ id: 'pro', condition: condition as never, output_handle: 'pro' }],
    otherwise: { output_handle: 'otherwise' },
  });

  it('branches on a choice a screen step sent to the Flow', async () => {
    const screen_answers = screenAnswersOf([
      { step_id: 'welcome:step', answers: { plan: 'free', news: true } },
      { step_id: 'upgrade:step', answers: { plan: 'pro' } },
    ]);

    // The step answered last wins for a key answered twice.
    expect(screen_answers).toEqual({ plan: 'pro', news: true });
    await expect(
      evaluateFlowConditionRows(
        rowsOf({ type: 'screen.answer', attribute: 'plan', value: 'pro' }),
        {
          screen_answers,
        }
      )
    ).resolves.toMatchObject({ matched: true, output_handle: 'pro' });
    await expect(
      evaluateFlowConditionRows(
        rowsOf({ type: 'screen.answer', attribute: 'plan', values: ['team', 'enterprise'] }),
        { screen_answers }
      )
    ).resolves.toMatchObject({ matched: false, output_handle: 'otherwise' });
    // A checkbox is its text.
    await expect(
      evaluateFlowConditionRows(
        rowsOf({ type: 'screen.answer', attribute: 'news', value: 'true' }),
        {
          screen_answers,
        }
      )
    ).resolves.toMatchObject({ matched: true });
  });

  it('matches nothing for an answer not given, or no key', async () => {
    for (const condition of [
      { type: 'screen.answer', attribute: 'missing', value: 'pro' },
      { type: 'screen.answer', value: 'pro' },
      { type: 'screen.answer', attribute: 'toString', value: 'pro' },
    ]) {
      await expect(
        evaluateFlowConditionRows(rowsOf(condition), { screen_answers: { plan: 'pro' } })
      ).resolves.toMatchObject({ matched: false });
    }
    await expect(
      evaluateFlowConditionRows(
        rowsOf({ type: 'screen.answer', attribute: 'plan', value: 'pro' }),
        {}
      )
    ).resolves.toMatchObject({ matched: false });
  });

  it('matches a box left unticked, and one of several values', async () => {
    await expect(
      evaluateFlowConditionRows(
        rowsOf({ type: 'screen.answer', attribute: 'news', value: 'false' }),
        { screen_answers: { news: false } }
      )
    ).resolves.toMatchObject({ matched: true });
    await expect(
      evaluateFlowConditionRows(
        rowsOf({ type: 'screen.answer', attribute: 'plan', values: ['team', 'business pro'] }),
        { screen_answers: { plan: 'business pro' } }
      )
    ).resolves.toMatchObject({ matched: true });
  });

  it('takes an answer key of up to 100 characters', () => {
    const codesFor = (attribute: unknown) =>
      validateFlowEditorState({
        nodes: [
          { id: 'entry', type: 'entry' },
          {
            id: 'branch',
            type: 'condition',
            config: { conditions: rowsOf({ type: 'screen.answer', attribute, value: 'pro' }) },
          },
        ],
        edges: [{ id: 'entry-branch', source: 'entry', target: 'branch' }],
      }).map((issue) => issue.code);

    expect(codesFor('k'.repeat(100))).not.toContain('invalid_screen_answer_condition');
    for (const attribute of ['k'.repeat(101), '   ', 7]) {
      expect(codesFor(attribute)).toContain('invalid_screen_answer_condition');
    }
  });

  it('refuses a screen answer condition without an answer key', () => {
    const issues = validateFlowEditorState({
      nodes: [
        { id: 'entry', type: 'entry' },
        {
          id: 'branch',
          type: 'condition',
          config: { conditions: rowsOf({ type: 'screen.answer', value: 'pro' }) },
        },
      ],
      edges: [{ id: 'entry-branch', source: 'entry', target: 'branch' }],
    });

    expect(issues.map((issue) => issue.code)).toContain('invalid_screen_answer_condition');
  });

  it('takes the step answered last, an integer-like step id included', () => {
    // An object would list '2' before '10' whatever the order they were set in; the list keeps it.
    expect(
      screenAnswersOf([
        { step_id: '10', answers: { plan: 'free' } },
        { step_id: '2', answers: { plan: 'pro' } },
      ])
    ).toEqual({ plan: 'pro' });
  });

  it('reads the object by step an earlier runtime kept', () => {
    expect(
      screenAnswerEntriesOf({ 'a:step': { plan: 'free' }, 'b:step': { plan: 'pro' } })
    ).toEqual([
      { step_id: 'a:step', answers: { plan: 'free' } },
      { step_id: 'b:step', answers: { plan: 'pro' } },
    ]);
  });

  it('ignores what is not an answer', () => {
    expect(screenAnswersOf(null)).toEqual({});
    expect(screenAnswersOf({ step: { plan: 3, items: ['a'], ok: false } })).toEqual({ ok: false });
    expect(
      screenAnswerEntriesOf([null, { step_id: 1, answers: {} }, { step_id: 's', answers: [] }])
    ).toEqual([]);
  });
});
