import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { DatabaseAdapter, Env, FlowRuntimeContract } from '@authrim/ar-lib-core';
import {
  cleanupExpiredFlowInteractions,
  clearLoginRuntimeFlowVersionCacheForTests,
  loginRuntimeInteractionStartHandler,
  loginRuntimeInteractionSubmitHandler,
} from '../login-runtime-flow';

const mocks = vi.hoisted(() => {
  const coreAdapter = {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn(),
    close: vi.fn(),
  };
  const sessionStore = {
    getSessionRpc: vi.fn(),
  };
  const idQueue = ['interaction_1', 'step_1', 'audit_1', 'audit_2', 'step_2', 'audit_3'];

  return {
    coreAdapter,
    sessionStore,
    idQueue,
    consumeAuthorizationChallengeContinuation: vi.fn(),
    getFeatureFlag: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
});

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({
      coreAdapter: mocks.coreAdapter,
    })),
    generateId: vi.fn(() => mocks.idQueue.shift() ?? `generated_${mocks.idQueue.length}`),
    getFeatureFlag: mocks.getFeatureFlag,
    getSessionStoreBySessionId: vi.fn(() => ({ stub: mocks.sessionStore })),
    isShardedSessionId: vi.fn((id: string) => id.startsWith('sess_')),
    getLogger: vi.fn(() => ({
      module: vi.fn(() => ({
        info: mocks.info,
        warn: mocks.warn,
        error: mocks.error,
      })),
    })),
    getTenantIdFromContext: vi.fn(() => 'tenant_test'),
  };
});

vi.mock('../direct-auth', () => ({
  consumeAuthorizationChallengeContinuation: mocks.consumeAuthorizationChallengeContinuation,
}));

type RuntimeContext = Context<{ Bindings: Env }>;

const runtime: FlowRuntimeContract = {
  flow_kind: 'login',
  ui: {
    steps: [
      {
        id: 'entry:step',
        source_node_id: 'entry',
        component: 'interaction_context',
        render: false,
      },
      {
        id: 'auth:step',
        source_node_id: 'auth',
        component: 'authentication_method_selector',
        render: true,
      },
      {
        id: 'complete:step',
        source_node_id: 'complete',
        component: 'completion',
        render: true,
      },
    ],
  },
};

const branchingRuntime: FlowRuntimeContract = {
  flow_kind: 'login',
  ui: {
    steps: [
      {
        id: 'entry:step',
        source_node_id: 'entry',
        component: 'interaction_context',
        render: false,
      },
      {
        id: 'auth:step',
        source_node_id: 'auth',
        component: 'authentication_method_selector',
        render: true,
      },
      {
        id: 'consent:step',
        source_node_id: 'consent',
        component: 'consent_policy',
        render: true,
      },
      {
        id: 'complete:step',
        source_node_id: 'complete',
        component: 'completion',
        render: true,
      },
    ],
  },
};

const oidcCompletionRuntime: FlowRuntimeContract = {
  flow_kind: 'login',
  ui: {
    steps: [
      {
        id: 'entry:step',
        source_node_id: 'entry',
        component: 'interaction_context',
        render: false,
      },
      {
        id: 'complete:step',
        source_node_id: 'complete',
        component: 'completion',
        render: true,
        config: {
          completion_block: {
            id: 'oidc-authorization-completion',
            protocol: 'oidc',
            purpose: 'authorization',
            role: 'output',
          },
        },
      },
    ],
  },
};

const oidcAuthCompletionRuntime: FlowRuntimeContract = {
  flow_kind: 'login',
  ui: {
    steps: [
      {
        id: 'auth:step',
        source_node_id: 'auth',
        component: 'authentication_method_selector',
        render: true,
      },
      {
        id: 'complete:step',
        source_node_id: 'complete',
        component: 'completion',
        render: true,
        config: {
          completion_block: {
            id: 'oidc-authorization-completion',
            protocol: 'oidc',
            purpose: 'authorization',
            role: 'output',
          },
        },
      },
    ],
  },
};

const branchingEditor = {
  nodes: [
    { id: 'entry', type: 'entry' },
    { id: 'auth', type: 'authentication' },
    { id: 'consent', type: 'consent' },
    { id: 'complete', type: 'complete' },
  ],
  edges: [
    { id: 'edge_entry_auth', source: 'entry', target: 'auth', source_handle: 'next' },
    { id: 'edge_auth_consent', source: 'auth', target: 'consent', source_handle: 'mail_otp' },
    { id: 'edge_auth_complete', source: 'auth', target: 'complete', source_handle: 'passkey' },
  ],
};

const conditionRuntime: FlowRuntimeContract = {
  flow_kind: 'login',
  ui: {
    steps: [
      {
        id: 'entry:step',
        source_node_id: 'entry',
        component: 'interaction_context',
        render: false,
      },
      {
        id: 'scope-condition:step',
        source_node_id: 'scope-condition',
        component: 'condition',
        render: false,
        config: {
          conditions: {
            rows: [
              {
                id: 'profile-scope',
                label: 'Profile scope requested',
                condition: { type: 'requested_scope', value: 'profile' },
                output_handle: 'needs_consent',
              },
            ],
            otherwise: { output_handle: 'skip_consent' },
          },
        },
      },
      {
        id: 'consent:step',
        source_node_id: 'consent',
        component: 'consent_policy',
        render: true,
      },
      {
        id: 'complete:step',
        source_node_id: 'complete',
        component: 'completion',
        render: true,
      },
    ],
  },
};

const conditionEditor = {
  nodes: [
    { id: 'entry', type: 'entry' },
    { id: 'scope-condition', type: 'condition' },
    { id: 'consent', type: 'consent' },
    { id: 'complete', type: 'complete' },
  ],
  edges: [
    {
      id: 'edge_entry_condition',
      source: 'entry',
      target: 'scope-condition',
      source_handle: 'next',
    },
    {
      id: 'edge_condition_consent',
      source: 'scope-condition',
      target: 'consent',
      source_handle: 'needs_consent',
    },
    {
      id: 'edge_condition_complete',
      source: 'scope-condition',
      target: 'complete',
      source_handle: 'skip_consent',
    },
  ],
};

function createContext(input: {
  body?: Record<string, unknown>;
  env?: Partial<Env> & { FLOW_RUNTIME_HMAC_SECRET?: string; ENABLE_LOGIN_RUNTIME_FLOW?: string };
  headers?: Record<string, string>;
  params?: Record<string, string>;
  url?: string;
}): RuntimeContext {
  const request = {
    json: vi.fn(async () => input.body ?? {}),
    param: vi.fn((name: string) => input.params?.[name] ?? ''),
    header: vi.fn((name: string) => input.headers?.[name] ?? input.headers?.[name.toLowerCase()]),
    url: input.url ?? 'https://first.test.authrim.com/api/v1/login/interactions/start',
  };

  return {
    req: request,
    env: {
      ENABLE_LOGIN_RUNTIME_FLOW: 'true',
      FLOW_RUNTIME_HMAC_SECRET: 'flow-runtime-secret',
      ...input.env,
    } as Env,
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  } as unknown as RuntimeContext;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const data: unknown = await response.json();
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

function resetAdapter() {
  vi.clearAllMocks();
  mocks.coreAdapter.query.mockReset();
  mocks.coreAdapter.queryOne.mockReset();
  mocks.coreAdapter.execute.mockReset();
  mocks.coreAdapter.transaction.mockReset();
  mocks.coreAdapter.batch.mockReset();
  mocks.coreAdapter.isHealthy.mockReset();
  mocks.coreAdapter.getType.mockReset();
  mocks.coreAdapter.close.mockReset();
  mocks.sessionStore.getSessionRpc.mockReset();
  mocks.consumeAuthorizationChallengeContinuation.mockReset();
  clearLoginRuntimeFlowVersionCacheForTests();
  mocks.idQueue.splice(
    0,
    mocks.idQueue.length,
    'interaction_1',
    'step_1',
    'audit_1',
    'audit_2',
    'step_2',
    'audit_3'
  );
  mocks.coreAdapter.getType.mockReturnValue('mock');
  mocks.coreAdapter.transaction.mockImplementation(
    async (fn: (tx: DatabaseAdapter) => Promise<unknown>) => {
      const tx = {
        execute: vi.fn(async () => ({ success: true, rowsAffected: 1 })),
      } as unknown as DatabaseAdapter;
      return fn(tx);
    }
  );
  mocks.coreAdapter.query.mockResolvedValue([]);
  mocks.coreAdapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
  mocks.getFeatureFlag.mockImplementation((_key: string, env: Env) => {
    return (
      (env as Env & { ENABLE_LOGIN_RUNTIME_FLOW?: string }).ENABLE_LOGIN_RUNTIME_FLOW === 'true'
    );
  });
}

function mockStartQueries(runtimeSnapshot: FlowRuntimeContract = runtime) {
  mocks.coreAdapter.queryOne
    .mockResolvedValueOnce({
      flow_id: 'flow_login',
      target_type: 'tenant',
      target_id: null,
      flow_kind: 'login',
      published_version_id: 'fv_1',
    })
    .mockResolvedValueOnce({
      id: 'fv_1',
      flow_id: 'flow_login',
      schema_version: 'authrim.login_ui.contract.v1',
      runtime_snapshot_json: JSON.stringify(runtimeSnapshot),
      editor_snapshot_json: null,
      published_at: 1782770000,
    });
}

function mockSubmitQueries(input: {
  state?: string;
  expiresAt?: number;
  contractHash: string;
  signature: string;
  currentNodeId?: string;
  currentStepId?: string;
  stepState?: string;
  runtimeSnapshot?: FlowRuntimeContract;
  editorSnapshot?: Record<string, unknown> | null;
  context?: Record<string, unknown>;
}) {
  const currentNodeId = input.currentNodeId ?? 'entry';
  const currentStepId = input.currentStepId ?? 'entry:step';
  mocks.coreAdapter.queryOne
    .mockResolvedValueOnce({
      id: 'interaction_1',
      flow_id: 'flow_login',
      flow_version_id: 'fv_1',
      client_id: null,
      saml_sp_id: null,
      state: input.state ?? 'active',
      current_node_id: currentNodeId,
      current_step_id: currentStepId,
      context_json: JSON.stringify({
        protocol: 'oidc',
        target_type: 'tenant',
        target_id: null,
        client_id: null,
        saml_sp_id: null,
        requested_scope: ['openid', 'profile'],
        locale: 'en',
        ...input.context,
      }),
      contract_hash: input.contractHash,
      signature: input.signature,
      expires_at: input.expiresAt ?? Math.floor(Date.now() / 1000) + 600,
    })
    .mockResolvedValueOnce({
      id: 'step_1',
      interaction_id: 'interaction_1',
      node_id: currentNodeId,
      step_id: currentStepId,
      state: input.stepState ?? 'pending',
      selected_handle: null,
      state_json: null,
    })
    .mockResolvedValueOnce({
      id: 'fv_1',
      flow_id: 'flow_login',
      schema_version: 'authrim.login_ui.contract.v1',
      runtime_snapshot_json: JSON.stringify(input.runtimeSnapshot ?? runtime),
      editor_snapshot_json:
        input.editorSnapshot === undefined ? null : JSON.stringify(input.editorSnapshot),
      published_at: 1782770000,
    });
}

async function startInteraction(
  body: Record<string, unknown> = { flow_kind: 'login' },
  runtimeSnapshot: FlowRuntimeContract = runtime
) {
  mockStartQueries(runtimeSnapshot);
  const response = await loginRuntimeInteractionStartHandler(createContext({ body }));
  const data = await readJson(response);
  return { response, data };
}

describe('LoginUI runtime Flow handlers', () => {
  beforeEach(() => {
    resetAdapter();
  });

  it('creates an interaction from the tenant default published Flow assignment', async () => {
    const { response, data } = await startInteraction();

    expect(response.status).toBe(200);
    expect(data.schema_version).toBe('authrim.login_ui.contract.v1');
    expect(data.resumed).toBe(false);
    expect(data.contract_hash).toEqual(expect.any(String));
    expect(data.signature).toEqual(expect.any(String));
    expect(mocks.coreAdapter.transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects start when the runtime feature flag is disabled', async () => {
    const response = await loginRuntimeInteractionStartHandler(
      createContext({
        body: { flow_kind: 'login' },
        env: { ENABLE_LOGIN_RUNTIME_FLOW: 'false' },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(403);
    expect(data.error).toBe('flow_runtime_disabled');
    expect(mocks.coreAdapter.queryOne).not.toHaveBeenCalled();
  });

  it('rejects resume when only the interaction ID is supplied', async () => {
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({
      id: 'interaction_1',
      flow_id: 'flow_login',
      flow_version_id: 'fv_1',
      client_id: null,
      saml_sp_id: null,
      state: 'active',
      current_node_id: 'entry',
      current_step_id: 'entry:step',
      context_json: null,
      contract_hash: 'hash',
      signature: 'sig',
      expires_at: Math.floor(Date.now() / 1000) + 600,
    });

    const response = await loginRuntimeInteractionStartHandler(
      createContext({ body: { resume_interaction_id: 'interaction_1' } })
    );
    const data = await readJson(response);

    expect(response.status).toBe(403);
    expect(data.error).toBe('invalid_runtime_signature');
    expect(data.category).toBe('security_error');
  });

  it('advances a signed active interaction to the next runtime step', async () => {
    const { data: startData } = await startInteraction();
    resetAdapter();
    mockSubmitQueries({
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
    });

    const response = await loginRuntimeInteractionSubmitHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        body: {
          step_id: 'entry:step',
          node_id: 'entry',
          contract_hash: startData.contract_hash,
          signature: startData.signature,
        },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(200);
    expect(data.completed).toBe(false);
    expect(data.step).toMatchObject({
      id: 'auth:step',
      source_node_id: 'auth',
      component: 'authentication_method_selector',
    });
    expect(mocks.coreAdapter.transaction).toHaveBeenCalledTimes(1);
  });

  it('uses editor edge handles to resolve the next runtime step', async () => {
    const { data: startData } = await startInteraction();
    resetAdapter();
    mockSubmitQueries({
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      currentNodeId: 'auth',
      currentStepId: 'auth:step',
      stepState: 'waiting_input',
      runtimeSnapshot: branchingRuntime,
      editorSnapshot: branchingEditor,
    });

    const response = await loginRuntimeInteractionSubmitHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        body: {
          step_id: 'auth:step',
          node_id: 'auth',
          selected_handle: 'passkey',
          contract_hash: startData.contract_hash,
          signature: startData.signature,
        },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(200);
    expect(data.completed).toBe(false);
    expect(data.step).toMatchObject({
      id: 'complete:step',
      source_node_id: 'complete',
      component: 'completion',
    });
  });

  it('evaluates condition nodes with request context and resolves the selected branch', async () => {
    const { data: startData } = await startInteraction(
      { flow_kind: 'login', requested_scope: 'openid profile' },
      conditionRuntime
    );
    resetAdapter();
    mockSubmitQueries({
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      currentNodeId: 'scope-condition',
      currentStepId: 'scope-condition:step',
      stepState: 'pending',
      runtimeSnapshot: conditionRuntime,
      editorSnapshot: conditionEditor,
    });

    const response = await loginRuntimeInteractionSubmitHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        body: {
          step_id: 'scope-condition:step',
          node_id: 'scope-condition',
          contract_hash: startData.contract_hash,
          signature: startData.signature,
        },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(200);
    expect(data.completed).toBe(false);
    expect(data.step).toMatchObject({
      id: 'consent:step',
      source_node_id: 'consent',
      component: 'consent_policy',
    });
  });

  it('rejects an unknown selected edge handle instead of falling back to the default branch', async () => {
    const { data: startData } = await startInteraction();
    resetAdapter();
    mockSubmitQueries({
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      currentNodeId: 'auth',
      currentStepId: 'auth:step',
      stepState: 'waiting_input',
      runtimeSnapshot: branchingRuntime,
      editorSnapshot: branchingEditor,
    });

    const response = await loginRuntimeInteractionSubmitHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        body: {
          step_id: 'auth:step',
          node_id: 'auth',
          selected_handle: 'twitter',
          contract_hash: startData.contract_hash,
          signature: startData.signature,
        },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toBe('invalid_flow_branch');
    expect(data.error_code).toBe('AR_FLOW_INVALID_SELECTED_HANDLE');
    expect(data.category).toBe('security_error');
    expect(mocks.coreAdapter.transaction).not.toHaveBeenCalled();
  });

  it('returns protocol continuation metadata when the completion step finishes', async () => {
    const { data: startData } = await startInteraction(
      { flow_kind: 'login', client_id: 'client_1', requested_scope: 'openid profile' },
      oidcCompletionRuntime
    );
    resetAdapter();
    mockSubmitQueries({
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      currentNodeId: 'complete',
      currentStepId: 'complete:step',
      stepState: 'waiting_input',
      runtimeSnapshot: oidcCompletionRuntime,
      editorSnapshot: null,
    });

    const response = await loginRuntimeInteractionSubmitHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        body: {
          step_id: 'complete:step',
          node_id: 'complete',
          selected_handle: 'completed',
          contract_hash: startData.contract_hash,
          signature: startData.signature,
        },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(200);
    expect(data.completed).toBe(true);
    expect(data.output).toMatchObject({
      action: 'continue_protocol',
      protocol_continuation: {
        type: 'protocol_continuation',
        protocol: 'oidc',
        flow_id: 'flow_login',
        flow_version_id: 'fv_1',
        interaction_id: 'interaction_1',
        completion_block: {
          id: 'oidc-authorization-completion',
          protocol: 'oidc',
          purpose: 'authorization',
          role: 'output',
        },
      },
    });
  });

  it('returns an OIDC continuation redirect when completion uses an existing session', async () => {
    const { data: startData } = await startInteraction(
      {
        flow_kind: 'login',
        client_id: 'client_1',
        requested_scope: 'openid profile',
        authorization_challenge_id: 'login_challenge_1',
      },
      oidcCompletionRuntime
    );
    resetAdapter();
    mockSubmitQueries({
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      currentNodeId: 'complete',
      currentStepId: 'complete:step',
      stepState: 'waiting_input',
      runtimeSnapshot: oidcCompletionRuntime,
      editorSnapshot: null,
      context: {
        target_type: 'oidc_client',
        target_id: 'client_1',
        client_id: 'client_1',
        authorization_challenge_id: 'login_challenge_1',
      },
    });
    mocks.coreAdapter.queryOne.mockResolvedValueOnce(null);
    mocks.coreAdapter.query.mockResolvedValueOnce([
      { step_id: 'complete:step', selected_handle: 'completed' },
    ]);
    mocks.sessionStore.getSessionRpc
      .mockResolvedValueOnce({
        userId: 'user_1',
        expiresAt: Date.now() + 60_000,
        createdAt: 1_700_000_000_000,
        data: { authTime: 1_700_000_123 },
      })
      .mockResolvedValueOnce({
        userId: 'user_1',
        expiresAt: Date.now() + 60_000,
        createdAt: 1_700_000_000_000,
        data: { authTime: 1_700_000_123 },
      });
    mocks.consumeAuthorizationChallengeContinuation.mockResolvedValueOnce({
      type: 'login',
      redirectUrl: 'https://first.test.authrim.com/authorize?_confirmation_challenge=confirm_1',
    });

    const response = await loginRuntimeInteractionSubmitHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        headers: { Cookie: 'authrim_session=sess_runtime_1' },
        url: 'https://first.test.authrim.com/api/v1/login/interactions/interaction_1/submit',
        body: {
          step_id: 'complete:step',
          node_id: 'complete',
          selected_handle: 'completed',
          contract_hash: startData.contract_hash,
          signature: startData.signature,
        },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(200);
    expect(data.output).toMatchObject({
      action: 'continue_protocol',
      redirect_url: 'https://first.test.authrim.com/authorize?_confirmation_challenge=confirm_1',
      protocol_continuation: {
        protocol: 'oidc',
        authorization_challenge_id: 'login_challenge_1',
      },
    });
    expect(mocks.consumeAuthorizationChallengeContinuation).toHaveBeenCalledWith(
      expect.any(Object),
      'tenant_test',
      'login_challenge_1',
      'user_1',
      1_700_000_123,
      'https://first.test.authrim.com'
    );
  });

  it('returns an OIDC continuation redirect after an authentication method step completes', async () => {
    const { data: startData } = await startInteraction(
      {
        flow_kind: 'login',
        client_id: 'client_1',
        requested_scope: 'openid profile',
        authorization_challenge_id: 'login_challenge_1',
      },
      oidcAuthCompletionRuntime
    );
    resetAdapter();
    mockSubmitQueries({
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      currentNodeId: 'complete',
      currentStepId: 'complete:step',
      stepState: 'waiting_input',
      runtimeSnapshot: oidcAuthCompletionRuntime,
      editorSnapshot: null,
      context: {
        target_type: 'oidc_client',
        target_id: 'client_1',
        client_id: 'client_1',
        authorization_challenge_id: 'login_challenge_1',
      },
    });
    mocks.coreAdapter.query.mockResolvedValueOnce([
      { step_id: 'auth:step', selected_handle: 'external:github' },
    ]);
    mocks.sessionStore.getSessionRpc
      .mockResolvedValueOnce({
        userId: 'user_1',
        expiresAt: Date.now() + 60_000,
        createdAt: 1_700_000_000_000,
        data: { authTime: 1_700_000_123 },
      })
      .mockResolvedValueOnce({
        userId: 'user_1',
        expiresAt: Date.now() + 60_000,
        createdAt: 1_700_000_000_000,
        data: { authTime: 1_700_000_123 },
      });
    mocks.consumeAuthorizationChallengeContinuation.mockResolvedValueOnce({
      type: 'login',
      redirectUrl: 'https://first.test.authrim.com/authorize?_confirmation_challenge=confirm_1',
    });

    const response = await loginRuntimeInteractionSubmitHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        headers: { Cookie: 'authrim_session=sess_runtime_1' },
        url: 'https://first.test.authrim.com/api/v1/login/interactions/interaction_1/submit',
        body: {
          step_id: 'complete:step',
          node_id: 'complete',
          selected_handle: 'completed',
          contract_hash: startData.contract_hash,
          signature: startData.signature,
        },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(200);
    expect(data.output).toMatchObject({
      action: 'continue_protocol',
      redirect_url: 'https://first.test.authrim.com/authorize?_confirmation_challenge=confirm_1',
      protocol_continuation: {
        protocol: 'oidc',
        authorization_challenge_id: 'login_challenge_1',
      },
    });
  });

  it('rejects submit when the runtime signature does not match the active interaction', async () => {
    const { data: startData } = await startInteraction();
    resetAdapter();
    mockSubmitQueries({
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
    });

    const response = await loginRuntimeInteractionSubmitHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        body: {
          step_id: 'entry:step',
          contract_hash: startData.contract_hash,
          signature: 'tampered',
        },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(403);
    expect(data.category).toBe('security_error');
    expect(data.action).toBe('restart_interaction');
    expect(mocks.coreAdapter.transaction).not.toHaveBeenCalled();
  });

  it('expires stale interactions before accepting submitted step data', async () => {
    const { data: startData } = await startInteraction();
    resetAdapter();
    mockSubmitQueries({
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    });

    const response = await loginRuntimeInteractionSubmitHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        body: {
          step_id: 'entry:step',
          contract_hash: startData.contract_hash,
          signature: startData.signature,
        },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toBe('interaction_expired');
    expect(data.category).toBe('restart_required');
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET state = 'expired'"),
      expect.arrayContaining(['tenant_test', 'interaction_1'])
    );
  });

  it('marks expired Flow interactions and deletes stale step rows during cleanup', async () => {
    mocks.coreAdapter.execute
      .mockResolvedValueOnce({ success: true, rowsAffected: 2 })
      .mockResolvedValueOnce({ success: true, rowsAffected: 3 });

    const result = await cleanupExpiredFlowInteractions(
      mocks.coreAdapter as DatabaseAdapter,
      'tenant_test',
      {
        now: 1782770600,
        retentionSeconds: 3600,
      }
    );

    expect(result).toEqual({ expired: 2, deletedSteps: 3 });
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining("SET state = 'expired'"),
      [1782770600, 'tenant_test', 1782770600]
    );
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM flow_interaction_steps'),
      ['tenant_test', 'tenant_test', 1782767000]
    );
  });
});
