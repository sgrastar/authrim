/**
 * Shared fixtures for mut-flowengine-* FlowExecutor tests.
 * (Module mocks stay in each test file because vi.mock is hoisted per file.)
 */

import type {
  CompiledNode,
  CompiledPlan,
  CompiledTransition,
  GraphNodeType,
} from '../../flow-engine/types';

export const graphDef = {
  id: 'login-flow',
  flowVersion: '1.0.0',
  profileId: 'core.human-basic-login',
  nodes: [],
  edges: [],
  name: 'Login',
  description: 'Login flow',
  metadata: {},
};

export function node(
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

export function plan(overrides: Partial<CompiledPlan> = {}): CompiledPlan {
  return {
    id: 'login-flow',
    version: '1.0.0',
    sourceVersion: '1.0.0',
    profileId: 'core.human-basic-login',
    entryNodeId: 'current',
    nodes: new Map<string, CompiledNode>([
      ['current', node('current', 'custom_form', 'next')],
      ['next', node('next')],
    ]),
    transitions: new Map(),
    ...overrides,
  } as CompiledPlan;
}

/** Plan whose 'current' node is a decision/switch with the given config and transitions. */
export function routingPlan(
  type: 'decision' | 'switch',
  decisionConfig: CompiledNode['decisionConfig'],
  transitions: CompiledTransition[],
  extraNodes: string[] = ['next', 'fallback', 'other']
): CompiledPlan {
  const current = node('current', type);
  current.decisionConfig = decisionConfig;
  return plan({
    nodes: new Map<string, CompiledNode>([
      ['current', current],
      ...extraNodes.map((id) => [id, node(id)] as [string, CompiledNode]),
    ]),
    transitions: new Map([['current', transitions]]),
  });
}

export function sessionState(overrides: Record<string, unknown> = {}) {
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

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const initOk = () =>
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
  });
