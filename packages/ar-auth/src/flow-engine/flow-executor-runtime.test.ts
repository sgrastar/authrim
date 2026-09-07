import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';
import type { CompiledNode, CompiledPlan, FlowSubmitResponse, GraphNodeType } from './types';

const mocks = vi.hoisted(() => ({
  getFlow: vi.fn(),
  compile: vi.fn(),
  generate: vi.fn(),
  doFetch: vi.fn(),
  getFlowStateStoreStub: vi.fn(),
}));

vi.mock('@authrim/ar-lib-core', async () => {
  const actual =
    await vi.importActual<typeof import('@authrim/ar-lib-core')>('@authrim/ar-lib-core');
  return {
    ...actual,
    getFlowStateStoreStub: mocks.getFlowStateStoreStub,
  };
});

vi.mock('./flow-registry', async () => {
  const actual = await vi.importActual<typeof import('./flow-registry')>('./flow-registry');
  return {
    ...actual,
    createFlowRegistry: vi.fn(() => ({ getFlow: mocks.getFlow })),
  };
});

vi.mock('./flow-compiler', async () => {
  const actual = await vi.importActual<typeof import('./flow-compiler')>('./flow-compiler');
  return {
    ...actual,
    createFlowCompiler: vi.fn(() => ({ compile: mocks.compile })),
  };
});

vi.mock('./ui-contract-generator', async () => {
  const actual =
    await vi.importActual<typeof import('./ui-contract-generator')>('./ui-contract-generator');
  return {
    ...actual,
    createUIContractGenerator: vi.fn(() => ({ generate: mocks.generate })),
  };
});

import { FlowExecutor, createFlowExecutor } from './flow-executor';

const graph = {
  id: 'login-flow',
  flowVersion: '1.0.0',
  profileId: 'core.human-basic-login',
  nodes: [],
  edges: [],
  name: 'Login',
  description: 'Login flow',
  metadata: {},
};

function node(
  id: string,
  type: GraphNodeType = 'custom_form',
  nextOnSuccess: string | null = null
): CompiledNode {
  return {
    id,
    type,
    intent: 'authenticate_user',
    capabilities: [],
    nextOnSuccess,
    nextOnError: null,
  };
}

function plan(overrides: Partial<CompiledPlan> = {}): CompiledPlan {
  const nodes = new Map<string, CompiledNode>([
    ['current', node('current', 'custom_form', 'next')],
    ['next', node('next')],
    ['end', node('end', 'end')],
  ]);
  return {
    id: 'login-flow',
    version: '1.0.0',
    sourceVersion: '1.0.0',
    profileId: 'core.human-basic-login',
    entryNodeId: 'current',
    nodes,
    transitions: new Map(),
    ...overrides,
  } as CompiledPlan;
}

function branchingPlan(kind: 'decision' | 'switch', target = 'next'): CompiledPlan {
  const branchNode = node('current', kind);
  branchNode.decisionConfig =
    kind === 'decision'
      ? {
          branches: [
            {
              id: 'allowed',
              label: 'Allowed',
              condition: { key: 'form.country', operator: 'equals', value: 'JP' },
              priority: 1,
            },
          ],
          defaultBranch: 'denied',
        }
      : {
          switchKey: 'form.country',
          cases: [{ id: 'allowed', label: 'Allowed', values: ['JP', 'US'] }],
          defaultCase: 'denied',
        };
  return plan({
    nodes: new Map([
      ['current', branchNode],
      ['next', node('next')],
      ['fallback', node('fallback')],
    ]),
    transitions: new Map([
      [
        'current',
        [
          { targetNodeId: target, type: 'conditional', sourceHandle: 'allowed', priority: 1 },
          {
            targetNodeId: 'fallback',
            type: 'conditional',
            sourceHandle: 'denied',
            priority: 2,
          },
        ],
      ],
    ]),
  });
}

function sessionState(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    sessionId: 'flow-session-1',
    flowId: 'login-flow',
    flowType: 'login',
    tenantId: 'tenant-1',
    clientId: 'client-1',
    currentNodeId: 'current',
    visitedNodeIds: [],
    completedCapabilities: [],
    startedAt: now,
    expiresAt: now + 60_000,
    requestTimestamps: [],
    collectedData: {},
    oauthParams: { redirect_uri: 'https://client.example/callback' },
    ...overrides,
  };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createExecutor(compiledPlan = plan()) {
  mocks.compile.mockReturnValue(compiledPlan);
  return new FlowExecutor({ AUTHRIM_CONFIG: {} } as Env, { ttlMs: 120_000 });
}

async function initialize(executor: FlowExecutor) {
  mocks.doFetch.mockResolvedValueOnce(
    json({
      success: true,
      state: {
        sessionId: 'flow-session-1',
        flowId: 'login-flow',
        currentNodeId: 'current',
        visitedNodeIds: [],
        completedCapabilities: [],
        expiresAt: Date.now() + 60_000,
      },
    })
  );
  return executor.initFlow({ flowType: 'login', clientId: 'client-1', tenantId: 'tenant-1' });
}

function checkResponse(state = sessionState()) {
  return json({ found: false, state });
}

function submit(executor: FlowExecutor, overrides: Record<string, unknown> = {}) {
  return executor.submitCapability({
    sessionId: 'flow-session-1',
    requestId: 'request-1',
    capabilityId: 'password',
    response: { value: 'not-logged' },
    tenantId: 'tenant-1',
    clientId: 'client-1',
    ...overrides,
  });
}

describe('FlowExecutor real runtime behavior', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.getFlow.mockResolvedValue(graph);
    mocks.generate.mockImplementation(({ compiledNode }: { compiledNode: CompiledNode }) => ({
      nodeId: compiledNode.id,
      components: [],
    }));
    mocks.getFlowStateStoreStub.mockResolvedValue({
      stub: { fetch: mocks.doFetch },
    });
  });

  describe('security-safe diagnostic sanitization', () => {
    const sanitize = (value: unknown) =>
      (
        createExecutor() as unknown as {
          sanitizeForLogging(value: unknown): unknown;
        }
      ).sanitizeForLogging(value);

    it('redacts credential, token, session, payment, and identity secrets recursively', () => {
      expect(
        sanitize({
          password: 'password-value',
          clientSecret: 'secret-value',
          access_token: 'access-value',
          refreshToken: 'refresh-value',
          id_token: 'id-value',
          authorization: 'Bearer value',
          apiKey: 'api-value',
          session_id: 'session-value',
          creditCard: '4111111111111111',
          ssn: '000-00-0000',
          nested: { private_key: 'private-value', safe: 'visible' },
        })
      ).toEqual({
        password: '[REDACTED]',
        clientSecret: '[REDACTED]',
        access_token: '[REDACTED]',
        refreshToken: '[REDACTED]',
        id_token: '[REDACTED]',
        authorization: '[REDACTED]',
        apiKey: '[REDACTED]',
        session_id: '[REDACTED]',
        creditCard: '[REDACTED]',
        ssn: '[REDACTED]',
        nested: { private_key: '[REDACTED]', safe: 'visible' },
      });
    });

    it('handles primitives, null, arrays, and circular structures without throwing', () => {
      const circular: Record<string, unknown> = { safe: true };
      circular.self = circular;

      expect(sanitize(null)).toBeNull();
      expect(sanitize('visible')).toBe('visible');
      expect(sanitize([1, { token: 'hidden' }, null])).toEqual([1, { token: '[REDACTED]' }, null]);
      expect(sanitize(circular)).toEqual({ safe: true, self: '[CIRCULAR_REFERENCE]' });
    });

    it('bounds diagnostic traversal depth and collection size', () => {
      let deeplyNested: Record<string, unknown> = { leaf: 'value' };
      for (let depth = 0; depth < 12; depth++) deeplyNested = { child: deeplyNested };

      expect(JSON.stringify(sanitize(deeplyNested))).toContain('[MAX_DEPTH_EXCEEDED]');
      expect(sanitize(Array.from({ length: 101 }, (_, index) => index))).toBe(
        '[Array(101) - truncated to first 100 items]'
      );
      expect(
        sanitize(
          Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`key${index}`, index]))
        )
      ).toBe('[Object with 101 properties - truncated]');
    });
  });

  describe('initialization', () => {
    it.each([
      ['', 'client-1', 'Invalid tenantId'],
      ['   ', 'client-1', 'Invalid tenantId'],
      ['tenant-1', '', 'Invalid clientId'],
      ['tenant-1', '   ', 'Invalid clientId'],
    ])('rejects invalid tenant/client context', async (tenantId, clientId, message) => {
      await expect(
        createExecutor().initFlow({ flowType: 'login', tenantId, clientId })
      ).rejects.toThrow(message);
      expect(mocks.getFlow).not.toHaveBeenCalled();
    });

    it('rejects an unknown flow without touching durable state', async () => {
      mocks.getFlow.mockResolvedValueOnce(null);

      await expect(
        createExecutor().initFlow({
          flowType: 'login',
          tenantId: 'tenant-1',
          clientId: 'client-1',
        })
      ).rejects.toThrow('Flow not found: login');
      expect(mocks.doFetch).not.toHaveBeenCalled();
    });

    it('rejects a compiled plan whose entry node is missing', async () => {
      const compiledPlan = plan({ entryNodeId: 'missing' });

      await expect(initialize(createExecutor(compiledPlan))).rejects.toThrow(
        'Entry node not found: missing'
      );
    });

    it('skips a start node and initializes the DO with the displayed node', async () => {
      const start = node('start', 'start', 'current');
      const compiledPlan = plan({
        entryNodeId: 'start',
        nodes: new Map([
          ['start', start],
          ['current', node('current')],
        ]),
      });

      const result = await initialize(createExecutor(compiledPlan));

      expect(result.uiContract).toMatchObject({ nodeId: 'current' });
      const request = mocks.doFetch.mock.calls[0][0] as Request;
      expect(request.url).toBe('http://localhost/init');
      expect(await request.json()).toMatchObject({
        tenantId: 'tenant-1',
        clientId: 'client-1',
        entryNodeId: 'current',
        ttlMs: 120_000,
      });
    });

    it('keeps the start node when its successor is absent', async () => {
      const compiledPlan = plan({
        entryNodeId: 'start',
        nodes: new Map([['start', node('start', 'start', 'missing')]]),
      });

      const result = await initialize(createExecutor(compiledPlan));

      expect(result.uiContract).toMatchObject({ nodeId: 'start' });
    });

    it.each([
      [{ success: false, error: 'state unavailable' }, 'state unavailable'],
      [{ success: true }, 'Failed to initialize flow'],
    ])('propagates a failed DO initialization', async (doResult, message) => {
      mocks.doFetch.mockResolvedValueOnce(json(doResult));

      await expect(
        createExecutor().initFlow({
          flowType: 'login',
          tenantId: 'tenant-1',
          clientId: 'client-1',
        })
      ).rejects.toThrow(message);
    });

    it('factory creates a working executor', () => {
      expect(createFlowExecutor({} as Env)).toBeInstanceOf(FlowExecutor);
    });
  });

  describe('submission security boundaries', () => {
    it('requires tenant context before accessing durable state', async () => {
      const result = await submit(createExecutor(), { tenantId: ' ' });

      expect(result).toMatchObject({ type: 'error', error: { code: 'tenant_required' } });
      expect(mocks.doFetch).not.toHaveBeenCalled();
    });

    it('returns a DO check error with its stable code', async () => {
      mocks.doFetch.mockResolvedValueOnce(json({ error: 'request rejected', code: 'bad_request' }));

      const result = await submit(createExecutor());

      expect(result).toEqual({
        type: 'error',
        error: { code: 'bad_request', message: 'request rejected' },
      });
    });

    it('uses a generic check code when the DO omits one', async () => {
      mocks.doFetch.mockResolvedValueOnce(json({ error: 'request rejected' }));

      const result = await submit(createExecutor());

      expect(result).toMatchObject({ error: { code: 'check_error' } });
    });

    it('returns an idempotently cached result without processing again', async () => {
      const cached: FlowSubmitResponse = {
        type: 'redirect',
        redirect: { url: 'https://client.example/callback', method: 'GET' },
      };
      mocks.doFetch.mockResolvedValueOnce(json({ found: true, result: cached }));

      expect(await submit(createExecutor())).toEqual(cached);
      expect(mocks.doFetch).toHaveBeenCalledTimes(1);
    });

    it('does not process a missing session', async () => {
      mocks.doFetch.mockResolvedValueOnce(json({ found: false }));

      expect(await submit(createExecutor())).toMatchObject({
        type: 'error',
        error: { code: 'session_not_found' },
      });
    });

    it.each([
      [{ tenantId: 'tenant-2' }, { code: 'invalid_session', message: 'Session tenant mismatch' }],
      [{ clientId: 'client-2' }, { code: 'invalid_session', message: 'Session client mismatch' }],
    ])('rejects session context substitution', async (stateOverride, expectedError) => {
      mocks.doFetch.mockResolvedValueOnce(checkResponse(sessionState(stateOverride)));

      expect(await submit(createExecutor())).toMatchObject({ type: 'error', error: expectedError });
    });

    it('allows callers without a client ID while retaining the session client context', async () => {
      const executor = createExecutor();
      await initialize(executor);
      mocks.doFetch.mockResolvedValueOnce(checkResponse()).mockResolvedValueOnce(json({}));

      const result = await submit(executor, { clientId: undefined });

      expect(result.type).toBe('continue');
    });

    it('rate limits 30 recent submissions per session', async () => {
      const now = Date.now();
      mocks.doFetch.mockResolvedValueOnce(
        checkResponse(sessionState({ requestTimestamps: Array.from({ length: 30 }, () => now) }))
      );

      expect(await submit(createExecutor())).toMatchObject({
        type: 'error',
        error: { code: 'rate_limit_exceeded' },
      });
    });

    it('truncates attacker-controlled timestamp history before applying the rate limit', async () => {
      const old = Date.now() - 120_000;
      const executor = createExecutor();
      await initialize(executor);
      mocks.doFetch
        .mockResolvedValueOnce(
          checkResponse(sessionState({ requestTimestamps: Array.from({ length: 101 }, () => old) }))
        )
        .mockResolvedValueOnce(json({}));

      expect((await submit(executor)).type).toBe('continue');
      const submitRequest = mocks.doFetch.mock.calls.at(-1)?.[0] as Request;
      const body = (await submitRequest.json()) as { requestTimestamps: number[] };
      expect(body.requestTimestamps).toHaveLength(1);
    });

    it('expires sessions after 30 minutes independently of DO expiry', async () => {
      mocks.doFetch.mockResolvedValueOnce(
        checkResponse(sessionState({ startedAt: Date.now() - 30 * 60_000 - 1 }))
      );

      expect(await submit(createExecutor())).toMatchObject({
        type: 'error',
        error: { code: 'session_timeout' },
      });
    });

    it.each([
      [['current', 'current', 'current'], 'circular_reference'],
      [Array.from({ length: 50 }, (_, index) => `node-${index}`), 'flow_too_long'],
    ])('rejects abusive flow visit history', async (visitedNodeIds, code) => {
      mocks.doFetch.mockResolvedValueOnce(checkResponse(sessionState({ visitedNodeIds })));

      expect(await submit(createExecutor())).toMatchObject({ type: 'error', error: { code } });
    });

    it('treats malformed visit history as empty instead of trusting it', async () => {
      const executor = createExecutor();
      await initialize(executor);
      mocks.doFetch
        .mockResolvedValueOnce(checkResponse(sessionState({ visitedNodeIds: 'current' })))
        .mockResolvedValueOnce(json({}));

      expect((await submit(executor)).type).toBe('continue');
    });

    it('truncates oversized visit history before loop checks', async () => {
      const executor = createExecutor();
      await initialize(executor);
      const history = Array.from({ length: 201 }, (_, index) => `old-${index}`);
      mocks.doFetch
        .mockResolvedValueOnce(checkResponse(sessionState({ visitedNodeIds: history })))
        .mockResolvedValueOnce(json({}));

      const result = await submit(executor);

      expect(result).toMatchObject({ type: 'error', error: { code: 'flow_too_long' } });
    });
  });

  describe('plan transitions and state', () => {
    it.each([
      ['decision', 'JP', 'next'],
      ['decision', 'DE', 'fallback'],
      ['switch', 'US', 'next'],
      ['switch', 'DE', 'fallback'],
    ] as const)(
      'routes a %s node using trusted flow form data',
      async (kind, country, expected) => {
        const executor = createExecutor(branchingPlan(kind));
        await initialize(executor);
        mocks.doFetch
          .mockResolvedValueOnce(
            checkResponse(sessionState({ collectedData: { form: { country } } }))
          )
          .mockResolvedValueOnce(json({}));

        const result = await submit(executor);

        expect(result).toMatchObject({ type: 'continue', uiContract: { nodeId: expected } });
      }
    );

    it.each(['decision', 'switch'] as const)(
      'fails closed when a matched %s transition targets a missing node',
      async (kind) => {
        const executor = createExecutor(branchingPlan(kind, 'missing'));
        await initialize(executor);
        mocks.doFetch.mockResolvedValueOnce(
          checkResponse(sessionState({ collectedData: { form: { country: 'JP' } } }))
        );

        const result = await submit(executor);

        expect(result).toEqual({
          type: 'redirect',
          redirect: { url: 'https://client.example/callback', method: 'GET' },
        });
        expect(mocks.doFetch).toHaveBeenCalledTimes(2);
      }
    );

    it('does not follow prototype-chain keys in switch conditions', async () => {
      const compiledPlan = branchingPlan('switch');
      const switchNode = compiledPlan.nodes.get('current');
      if (!switchNode?.decisionConfig || !('switchKey' in switchNode.decisionConfig)) {
        throw new Error('switch fixture is invalid');
      }
      switchNode.decisionConfig.switchKey = 'form.constructor.name';
      const executor = createExecutor(compiledPlan);
      await initialize(executor);
      mocks.doFetch
        .mockResolvedValueOnce(checkResponse(sessionState({ collectedData: { form: {} } })))
        .mockResolvedValueOnce(json({}));

      const result = await submit(executor);

      expect(result).toMatchObject({ type: 'continue', uiContract: { nodeId: 'fallback' } });
    });

    it.each(['decision', 'switch'] as const)(
      'ends the flow when a %s node has no routing configuration',
      async (kind) => {
        const branchNode = node('current', kind);
        const executor = createExecutor(
          plan({ entryNodeId: 'current', nodes: new Map([['current', branchNode]]) })
        );
        await initialize(executor);
        mocks.doFetch.mockResolvedValueOnce(checkResponse());

        expect(await submit(executor)).toMatchObject({
          type: 'redirect',
          redirect: { url: 'https://client.example/callback' },
        });
      }
    );

    it('returns flow-not-found when an uncached session references a deleted flow', async () => {
      mocks.getFlow.mockResolvedValueOnce(null);
      mocks.doFetch.mockResolvedValueOnce(checkResponse());

      expect(await submit(createExecutor())).toMatchObject({
        type: 'error',
        error: { code: 'flow_not_found' },
      });
    });

    it('returns node-not-found for corrupted durable state', async () => {
      const executor = createExecutor();
      await initialize(executor);
      mocks.doFetch.mockResolvedValueOnce(
        checkResponse(sessionState({ currentNodeId: 'missing' }))
      );

      expect(await submit(executor)).toMatchObject({
        type: 'error',
        error: { code: 'node_not_found' },
      });
    });

    it('redirects to the registered URI when the current node completes the flow', async () => {
      const compiledPlan = plan({
        nodes: new Map([['current', node('current', 'custom_form', null)]]),
      });
      const executor = createExecutor(compiledPlan);
      await initialize(executor);
      mocks.doFetch.mockResolvedValueOnce(checkResponse());

      expect(await submit(executor)).toEqual({
        type: 'redirect',
        redirect: { url: 'https://client.example/callback', method: 'GET' },
      });
    });

    it('uses a safe local callback when OAuth state has no redirect URI', async () => {
      const compiledPlan = plan({
        nodes: new Map([['current', node('current', 'custom_form', null)]]),
      });
      const executor = createExecutor(compiledPlan);
      await initialize(executor);
      mocks.doFetch.mockResolvedValueOnce(checkResponse(sessionState({ oauthParams: undefined })));

      expect(await submit(executor)).toMatchObject({ redirect: { url: '/callback' } });
    });

    it('rejects a transition to a node absent from the compiled plan', async () => {
      const compiledPlan = plan({
        nodes: new Map([['current', node('current', 'custom_form', 'missing')]]),
      });
      const executor = createExecutor(compiledPlan);
      await initialize(executor);
      mocks.doFetch.mockResolvedValueOnce(checkResponse());

      expect(await submit(executor)).toMatchObject({
        type: 'error',
        error: { code: 'next_node_not_found' },
      });
    });

    it('redirects when the next node is an end node', async () => {
      const compiledPlan = plan({
        nodes: new Map([
          ['current', node('current', 'custom_form', 'end')],
          ['end', node('end', 'end')],
        ]),
      });
      const executor = createExecutor(compiledPlan);
      await initialize(executor);
      mocks.doFetch.mockResolvedValueOnce(checkResponse());

      expect(await submit(executor)).toMatchObject({
        type: 'redirect',
        redirect: { url: 'https://client.example/callback' },
      });
    });

    it('persists collected response and returns the next UI contract', async () => {
      const executor = createExecutor();
      await initialize(executor);
      mocks.doFetch
        .mockResolvedValueOnce(
          checkResponse(sessionState({ collectedData: { form: { username: 'alice' } } }))
        )
        .mockResolvedValueOnce(json({}));

      const result = await submit(executor);

      expect(result).toMatchObject({ type: 'continue', uiContract: { nodeId: 'next' } });
      expect(mocks.generate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          runtimeState: {
            collectedData: {
              form: { username: 'alice' },
              password: { value: 'not-logged' },
            },
          },
        })
      );
      const request = mocks.doFetch.mock.calls.at(-1)?.[0] as Request;
      expect(await request.json()).toMatchObject({
        requestId: 'request-1',
        nextNodeId: 'next',
        visitedNodes: ['current'],
      });
    });

    it('reads current state and recompiles an uncached plan', async () => {
      mocks.doFetch.mockResolvedValueOnce(json({ state: sessionState() }));

      const result = await createExecutor().getFlowState('flow-session-1', 'tenant-1');

      expect(result).toMatchObject({
        state: { currentNodeId: 'current', visitedNodeIds: [], completedCapabilities: [] },
        uiContract: { nodeId: 'current' },
      });
    });

    it.each([
      [{ error: 'expired' }, 'expired'],
      [{}, 'Session not found'],
    ])('rejects unavailable durable state', async (doResult, message) => {
      mocks.doFetch.mockResolvedValueOnce(json(doResult));

      await expect(createExecutor().getFlowState('flow-session-1', 'tenant-1')).rejects.toThrow(
        message
      );
    });

    it('rejects state for a flow definition that no longer exists', async () => {
      mocks.getFlow.mockResolvedValueOnce(null);
      mocks.doFetch.mockResolvedValueOnce(json({ state: sessionState() }));

      await expect(createExecutor().getFlowState('flow-session-1', 'tenant-1')).rejects.toThrow(
        'Compiled plan not found'
      );
    });

    it('rejects state whose current node is absent from the plan', async () => {
      mocks.doFetch.mockResolvedValueOnce(
        json({ state: sessionState({ currentNodeId: 'missing' }) })
      );

      await expect(createExecutor().getFlowState('flow-session-1', 'tenant-1')).rejects.toThrow(
        'Node not found: missing'
      );
    });

    it('cancels the tenant-scoped durable session with DELETE', async () => {
      mocks.doFetch.mockResolvedValueOnce(json({ success: true }));

      await createExecutor().cancelFlow('flow-session-1', 'tenant-1');

      const request = mocks.doFetch.mock.calls[0][0] as Request;
      expect(request.url).toBe('http://localhost/cancel');
      expect(request.method).toBe('DELETE');
      expect(request.headers.get('X-Tenant-Id')).toBe('tenant-1');
      expect(request.headers.get('X-Flow-Session-Id')).toBe('flow-session-1');
    });
  });
});
