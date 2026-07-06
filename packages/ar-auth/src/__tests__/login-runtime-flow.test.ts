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
  const challengeStore = {
    getChallengeRpc: vi.fn(),
  };
  const idQueue = ['interaction_1', 'step_1', 'audit_1', 'audit_2', 'step_2', 'audit_3'];

  return {
    coreAdapter,
    sessionStore,
    challengeStore,
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
    getChallengeStoreByChallengeId: vi.fn(() => mocks.challengeStore),
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

const consentRuntime: FlowRuntimeContract = {
  flow_kind: 'login',
  ui: {
    steps: [
      {
        id: 'consent:step',
        source_node_id: 'consent',
        component: 'consent_policy',
        render: true,
        config: {
          consent_policy_ref: 'policy_registration',
        },
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

const profileFormRuntime: FlowRuntimeContract = {
  flow_kind: 'registration',
  ui: {
    steps: [
      {
        id: 'profile:step',
        source_node_id: 'profile',
        component: 'profile_form',
        render: true,
        config: {
          profile_form_ref: 'registration',
        },
      },
    ],
  },
};

const authFormConsentRuntime: FlowRuntimeContract = {
  flow_kind: 'login',
  ui: {
    steps: [
      {
        id: 'auth:step',
        source_node_id: 'auth',
        component: 'authentication_method_selector',
        render: true,
        config: {
          authentication_profile_ref: 'default',
          profile_form_ref: 'login',
          consent_policy_ref: 'policy_login',
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

const implicitAccountActionRuntime: FlowRuntimeContract = {
  flow_kind: 'registration',
  ui: {
    steps: [
      {
        id: 'auth:step',
        source_node_id: 'auth',
        component: 'registration_method_selector',
        render: true,
      },
      {
        id: 'account-create:step',
        source_node_id: 'account-create',
        component: 'account_action',
        render: true,
        config: {
          ui_kind: 'account_action',
        },
      },
      {
        id: 'complete:step',
        source_node_id: 'complete',
        component: 'completion',
        render: true,
        config: {
          completion_block: {
            id: 'oidc-registration-completion',
            protocol: 'oidc',
            purpose: 'registration',
            role: 'output',
          },
        },
      },
    ],
  },
};

const implicitAccountActionEditor = {
  nodes: [
    { id: 'auth', type: 'registration' },
    { id: 'account-create', type: 'account_action' },
    { id: 'complete', type: 'complete' },
  ],
  edges: [
    { id: 'edge_auth_account', source: 'auth', target: 'account-create', source_handle: 'passkey' },
    {
      id: 'edge_account_complete',
      source: 'account-create',
      target: 'complete',
      source_handle: 'completed',
    },
  ],
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

const acceptedConsentRuntime: FlowRuntimeContract = {
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
        id: 'consent:step',
        source_node_id: 'consent',
        component: 'consent_policy',
        render: true,
        config: {
          consent_policy_ref: 'policy_registration',
        },
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

const acceptedConsentEditor = {
  nodes: [
    { id: 'auth', type: 'authentication' },
    { id: 'consent', type: 'consent' },
    { id: 'complete', type: 'complete' },
  ],
  edges: [
    { id: 'edge_auth_consent', source: 'auth', target: 'consent', source_handle: 'passkey' },
    { id: 'edge_consent_complete', source: 'consent', target: 'complete' },
  ],
};

const sessionCheckRuntime: FlowRuntimeContract = {
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
        id: 'session-check:step',
        source_node_id: 'session-check',
        component: 'session_check',
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

const emailVerificationRuntime: FlowRuntimeContract = {
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
        id: 'email-verify:step',
        source_node_id: 'email-verify',
        component: 'email_verification',
        render: false,
      },
      {
        id: 'auth:step',
        source_node_id: 'auth',
        component: 'authentication_method_selector',
        render: true,
      },
    ],
  },
};

const sessionCheckEditor = {
  nodes: [
    { id: 'entry', type: 'entry' },
    { id: 'session-check', type: 'session_check' },
    { id: 'auth', type: 'authentication' },
    { id: 'complete', type: 'complete' },
  ],
  edges: [
    { id: 'edge_entry_session', source: 'entry', target: 'session-check', source_handle: 'next' },
    {
      id: 'edge_session_complete',
      source: 'session-check',
      target: 'complete',
      source_handle: 'continue',
    },
    {
      id: 'edge_session_auth',
      source: 'session-check',
      target: 'auth',
      source_handle: 'authenticate',
    },
  ],
};

const mixedProtocolCompletionRuntime: FlowRuntimeContract = {
  flow_kind: 'login',
  ui: {
    steps: [
      {
        id: 'session-check:step',
        source_node_id: 'session-check',
        component: 'session_check',
        render: false,
      },
      {
        id: 'saml-complete:step',
        source_node_id: 'saml-complete',
        component: 'completion',
        render: true,
        config: {
          completion_block: {
            id: 'saml-attribute-release-completion',
            protocol: 'saml',
            purpose: 'attribute_release',
            role: 'output',
          },
        },
      },
      {
        id: 'oidc-complete:step',
        source_node_id: 'oidc-complete',
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

const mixedProtocolCompletionEditor = {
  nodes: [
    { id: 'session-check', type: 'session_check' },
    { id: 'saml-complete', type: 'complete' },
    { id: 'oidc-complete', type: 'complete' },
  ],
  edges: [
    {
      id: 'edge_session_saml_complete',
      source: 'session-check',
      target: 'saml-complete',
      source_handle: 'continue',
    },
    {
      id: 'edge_session_oidc_complete',
      source: 'session-check',
      target: 'oidc-complete',
      source_handle: 'continue',
    },
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
  mocks.challengeStore.getChallengeRpc.mockReset();
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

function mockStartQueries(
  runtimeSnapshot: FlowRuntimeContract = runtime,
  editorSnapshot: Record<string, unknown> | null = null
) {
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
      editor_snapshot_json: editorSnapshot ? JSON.stringify(editorSnapshot) : null,
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
  clientId?: string | null;
  samlSpId?: string | null;
}) {
  const currentNodeId = input.currentNodeId ?? 'entry';
  const currentStepId = input.currentStepId ?? 'entry:step';
  mocks.coreAdapter.queryOne
    .mockResolvedValueOnce({
      id: 'interaction_1',
      flow_id: 'flow_login',
      flow_version_id: 'fv_1',
      client_id: input.clientId ?? null,
      saml_sp_id: input.samlSpId ?? null,
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
  runtimeSnapshot: FlowRuntimeContract = runtime,
  editorSnapshot: Record<string, unknown> | null = null
) {
  if (typeof body.authorization_challenge_id === 'string') {
    mocks.challengeStore.getChallengeRpc.mockResolvedValueOnce({
      id: body.authorization_challenge_id,
      tenantId: 'tenant_test',
      type: 'login',
      userId: 'anonymous',
      challenge: body.authorization_challenge_id,
      metadata: {
        client_id: body.client_id,
      },
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
      consumed: false,
    });
  }
  mockStartQueries(runtimeSnapshot, editorSnapshot);
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
    expect(data.interaction).toMatchObject({
      current_node_id: 'auth',
      current_step_id: 'auth:step',
    });
    expect(mocks.coreAdapter.transaction).toHaveBeenCalledTimes(2);
  });

  it('rejects an authorization challenge bound to a different OIDC client', async () => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValueOnce({
      id: 'login_challenge_1',
      tenantId: 'tenant_test',
      type: 'login',
      userId: 'anonymous',
      challenge: 'login_challenge_1',
      metadata: {
        client_id: 'client_2',
      },
      createdAt: Date.now(),
      expiresAt: Date.now() + 600_000,
      consumed: false,
    });

    const response = await loginRuntimeInteractionStartHandler(
      createContext({
        body: {
          flow_kind: 'login',
          client_id: 'client_1',
          authorization_challenge_id: 'login_challenge_1',
        },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(403);
    expect(data.error).toBe('authorization_challenge_mismatch');
    expect(data.error_code).toBe('AR_FLOW_AUTH_CHALLENGE_MISMATCH');
    expect(mocks.coreAdapter.queryOne).not.toHaveBeenCalled();
    expect(mocks.coreAdapter.transaction).not.toHaveBeenCalled();
  });

  it('rejects a missing authorization challenge before creating a runtime interaction', async () => {
    mocks.challengeStore.getChallengeRpc.mockResolvedValueOnce(null);

    const response = await loginRuntimeInteractionStartHandler(
      createContext({
        body: {
          flow_kind: 'login',
          client_id: 'client_1',
          authorization_challenge_id: 'login_challenge_1',
        },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(400);
    expect(data.error).toBe('invalid_authorization_challenge');
    expect(data.error_code).toBe('AR_FLOW_AUTH_CHALLENGE_INVALID');
    expect(mocks.coreAdapter.queryOne).not.toHaveBeenCalled();
    expect(mocks.coreAdapter.transaction).not.toHaveBeenCalled();
  });

  it('includes bridge external IdP providers in authentication runtime handles', async () => {
    const externalIdp = {
      fetch: vi.fn(async () => {
        return new Response(
          JSON.stringify({
            providers: [
              {
                id: 'c86b7c28-7351-4587-a155-b578fa133702',
                slug: 'samplesauth0',
                name: 'samples.auth0',
                enabled: true,
              },
              {
                id: 'disabled-provider',
                slug: 'disabled',
                name: 'Disabled',
                enabled: false,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }),
    };
    mockStartQueries();

    const response = await loginRuntimeInteractionStartHandler(
      createContext({
        body: { flow_kind: 'login' },
        env: { EXTERNAL_IDP: externalIdp as unknown as Fetcher },
        headers: { Host: 'first.test.authrim.com', 'X-Forwarded-Proto': 'https' },
      })
    );
    const data = await readJson(response);
    const runtimeData = data.contract as FlowRuntimeContract;
    const authStep = runtimeData.ui.steps.find((step) => step.id === 'auth:step');
    const outputHandles = (authStep?.config as Record<string, unknown> | undefined)?.output_handles;

    expect(response.status).toBe(200);
    expect(outputHandles).toContain('samplesauth0');
    expect(outputHandles).not.toContain('disabled');
    expect(externalIdp.fetch).toHaveBeenCalledWith(
      'https://external-idp/api/external/providers',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Accept: 'application/json',
          'X-Tenant-Id': 'tenant_test',
          'X-Authrim-Forwarded-Host': 'first.test.authrim.com',
          'X-Forwarded-Host': 'first.test.authrim.com',
          'X-Forwarded-Proto': 'https',
        }),
      })
    );
  });

  it('auto-advances hidden session check steps during interaction start', async () => {
    const { response, data } = await startInteraction(
      { flow_kind: 'login' },
      sessionCheckRuntime,
      sessionCheckEditor
    );

    expect(response.status).toBe(200);
    expect(data.interaction).toMatchObject({
      current_node_id: 'auth',
      current_step_id: 'auth:step',
    });
    expect(mocks.coreAdapter.transaction).toHaveBeenCalledTimes(2);
  });

  it('uses the active-session branch while auto-advancing session check during start', async () => {
    mockStartQueries(sessionCheckRuntime, sessionCheckEditor);
    mocks.sessionStore.getSessionRpc.mockResolvedValueOnce({
      userId: 'user_1',
      expiresAt: Date.now() + 60_000,
      createdAt: 1_700_000_000_000,
      data: { authTime: 1_700_000_123 },
    });

    const response = await loginRuntimeInteractionStartHandler(
      createContext({
        body: { flow_kind: 'login' },
        headers: { Cookie: 'authrim_session=sess_runtime_1' },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(200);
    expect(data.interaction).toMatchObject({
      current_node_id: 'complete',
      current_step_id: 'complete:step',
    });
    expect(mocks.sessionStore.getSessionRpc).toHaveBeenCalledWith('sess_runtime_1');
  });

  it('evaluates hidden condition steps during interaction start', async () => {
    const { response, data } = await startInteraction(
      { flow_kind: 'login', requested_scope: 'openid profile' },
      conditionRuntime,
      conditionEditor
    );

    expect(response.status).toBe(200);
    expect(data.interaction).toMatchObject({
      current_node_id: 'consent',
      current_step_id: 'consent:step',
    });
  });

  it('does not auto-advance email verification steps without the verified handle', async () => {
    const { response, data } = await startInteraction(
      { flow_kind: 'login' },
      emailVerificationRuntime
    );

    expect(response.status).toBe(200);
    expect(data.interaction).toMatchObject({
      current_node_id: 'email-verify',
      current_step_id: 'email-verify:step',
    });
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

  it('caches the tenant runtime feature flag within the isolate', async () => {
    const authrimConfig = {
      get: vi.fn(async () =>
        JSON.stringify({
          'feature.enable_login_runtime_flow': true,
        })
      ),
    } as unknown as KVNamespace;

    mockStartQueries();
    const firstResponse = await loginRuntimeInteractionStartHandler(
      createContext({
        body: { flow_kind: 'login' },
        env: { AUTHRIM_CONFIG: authrimConfig },
      })
    );
    mockStartQueries();
    const secondResponse = await loginRuntimeInteractionStartHandler(
      createContext({
        body: { flow_kind: 'login' },
        env: { AUTHRIM_CONFIG: authrimConfig },
      })
    );

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(authrimConfig.get).toHaveBeenCalledTimes(1);
    expect(authrimConfig.get).toHaveBeenCalledWith('settings:tenant:tenant_test:feature-flags');
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

  it('hydrates profile form steps with the active form profile snapshot', async () => {
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce({
        flow_id: 'flow_registration',
        target_type: 'tenant',
        target_id: null,
        flow_kind: 'registration',
        published_version_id: 'fv_1',
      })
      .mockResolvedValueOnce({
        id: 'fv_1',
        flow_id: 'flow_registration',
        schema_version: 'authrim.login_ui.contract.v1',
        runtime_snapshot_json: JSON.stringify(profileFormRuntime),
        editor_snapshot_json: null,
        published_at: 1782770000,
      })
      .mockResolvedValueOnce({
        id: 'profile_1',
        profile_key: 'registration',
        display_name: 'Registration',
        description: 'Registration form',
        form_kind: 'registration',
        fields_json: JSON.stringify([
          {
            field: 'auth.mail_otp',
            label: 'Send verification code',
            text: 'Send a code to your email address.',
            required: false,
            block_type: 'auth_widget',
            auth_method: 'mail_otp',
          },
        ]),
        localizations_json: JSON.stringify({
          ja: {
            display_name: '新規登録',
            description: '標準の新規登録フォームです。',
            fields: {
              'auth.mail_otp-0': {
                label: '認証コードを送信',
                text: 'メールアドレスにコードを送信します。',
              },
            },
          },
        }),
        settings_json: JSON.stringify({ canvas_layout: 'narrow' }),
      });

    const response = await loginRuntimeInteractionStartHandler(
      createContext({ body: { flow_kind: 'registration', requested_locale: 'ja' } })
    );
    const data = await readJson(response);
    const runtimeData = data.contract as FlowRuntimeContract;

    expect(response.status).toBe(200);
    expect(runtimeData.ui.steps[0].config).toMatchObject({
      profile_form_ref: 'registration',
      form_profile: {
        id: 'profile_1',
        profile_key: 'registration',
        display_name: '新規登録',
        description: '標準の新規登録フォームです。',
        fields: [
          {
            label: '認証コードを送信',
            text: 'メールアドレスにコードを送信します。',
            block_type: 'auth_widget',
            auth_method: 'mail_otp',
          },
        ],
      },
    });
  });

  it('hydrates authentication steps with selected form and consent policy content', async () => {
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
        runtime_snapshot_json: JSON.stringify(authFormConsentRuntime),
        editor_snapshot_json: null,
        published_at: 1782770000,
      })
      .mockResolvedValueOnce({
        id: 'profile_login',
        profile_key: 'login',
        display_name: 'Login',
        description: 'Login form',
        form_kind: 'login',
        fields_json: JSON.stringify([
          {
            field: 'auth.passkey',
            label: 'Sign in with Passkey',
            required: false,
            block_type: 'auth_widget',
            auth_method: 'passkey',
          },
          {
            field: 'consent.policy',
            label: 'Consent',
            required: true,
            block_type: 'consent_widget',
          },
        ]),
        localizations_json: JSON.stringify({}),
        settings_json: JSON.stringify({ canvas_layout: 'narrow' }),
      })
      .mockResolvedValueOnce({
        id: 'policy_login',
        display_name: 'Login consent',
        description: 'Login consent policy',
        is_active: 1,
      });
    mocks.coreAdapter.query.mockResolvedValueOnce([]);

    const response = await loginRuntimeInteractionStartHandler(
      createContext({ body: { flow_kind: 'login' } })
    );
    const data = await readJson(response);
    const runtimeData = data.contract as FlowRuntimeContract;

    expect(response.status).toBe(200);
    expect(runtimeData.ui.steps[0].config).toMatchObject({
      profile_form_ref: 'login',
      form_profile: {
        id: 'profile_login',
        profile_key: 'login',
        fields: [
          {
            block_type: 'auth_widget',
            auth_method: 'passkey',
          },
          {
            block_type: 'consent_widget',
          },
        ],
      },
    });
    expect(runtimeData.ui.steps[0].content).toMatchObject({
      consent_policy: {
        id: 'policy_login',
        display_name: 'Login consent',
        items: [],
      },
    });
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
    expect(data.completed).toBe(true);
    expect(data.step).toBeNull();
  });

  it('skips implicit account action nodes instead of returning a Continue step', async () => {
    const { data: startData } = await startInteraction(
      { flow_kind: 'registration', client_id: 'client_1' },
      implicitAccountActionRuntime
    );
    resetAdapter();
    mockSubmitQueries({
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      currentNodeId: 'auth',
      currentStepId: 'auth:step',
      stepState: 'waiting_input',
      runtimeSnapshot: implicitAccountActionRuntime,
      editorSnapshot: implicitAccountActionEditor,
      clientId: 'client_1',
      context: {
        protocol: 'oidc',
        target_type: 'oidc_client',
        target_id: 'client_1',
        client_id: 'client_1',
      },
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
    expect(data.completed).toBe(true);
    expect(data.step).toBeNull();
    expect(data.output).toMatchObject({
      protocol_continuation: {
        completion_block: {
          id: 'oidc-registration-completion',
          protocol: 'oidc',
          purpose: 'registration',
          role: 'output',
        },
      },
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

  it('routes a session check node to authentication when no active session exists', async () => {
    const { data: startData } = await startInteraction({ flow_kind: 'login' }, sessionCheckRuntime);
    resetAdapter();
    mockSubmitQueries({
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      currentNodeId: 'session-check',
      currentStepId: 'session-check:step',
      stepState: 'pending',
      runtimeSnapshot: sessionCheckRuntime,
      editorSnapshot: sessionCheckEditor,
    });

    const response = await loginRuntimeInteractionSubmitHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        body: {
          step_id: 'session-check:step',
          node_id: 'session-check',
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
  });

  it('routes a session check node to continue when an active session exists', async () => {
    const { data: startData } = await startInteraction({ flow_kind: 'login' }, sessionCheckRuntime);
    resetAdapter();
    mockSubmitQueries({
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      currentNodeId: 'session-check',
      currentStepId: 'session-check:step',
      stepState: 'pending',
      runtimeSnapshot: sessionCheckRuntime,
      editorSnapshot: sessionCheckEditor,
    });
    mocks.sessionStore.getSessionRpc.mockResolvedValueOnce({
      userId: 'user_1',
      expiresAt: Date.now() + 60_000,
      createdAt: 1_700_000_000_000,
      data: { authTime: 1_700_000_123 },
    });

    const response = await loginRuntimeInteractionSubmitHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        headers: { Cookie: 'authrim_session=sess_runtime_1' },
        body: {
          step_id: 'session-check:step',
          node_id: 'session-check',
          contract_hash: startData.contract_hash,
          signature: startData.signature,
        },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(200);
    expect(data.completed).toBe(true);
    expect(data.step).toBeNull();
  });

  it('prefers the completion branch matching the active protocol when handles overlap', async () => {
    const { data: startData } = await startInteraction({ flow_kind: 'login' }, sessionCheckRuntime);
    resetAdapter();
    mockSubmitQueries({
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      currentNodeId: 'session-check',
      currentStepId: 'session-check:step',
      stepState: 'pending',
      runtimeSnapshot: mixedProtocolCompletionRuntime,
      editorSnapshot: mixedProtocolCompletionEditor,
      clientId: 'client_1',
      context: {
        protocol: 'oidc',
        target_type: 'oidc_client',
        target_id: 'client_1',
        client_id: 'client_1',
      },
    });
    mocks.sessionStore.getSessionRpc.mockResolvedValueOnce({
      userId: 'user_1',
      expiresAt: Date.now() + 60_000,
      createdAt: 1_700_000_000_000,
      data: { authTime: 1_700_000_123 },
    });

    const response = await loginRuntimeInteractionSubmitHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        headers: { Cookie: 'authrim_session=sess_runtime_1' },
        body: {
          step_id: 'session-check:step',
          node_id: 'session-check',
          contract_hash: startData.contract_hash,
          signature: startData.signature,
        },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(200);
    expect(data.completed).toBe(true);
    expect(data.output).toMatchObject({
      protocol_continuation: {
        protocol: 'oidc',
        completion_block: {
          id: 'oidc-authorization-completion',
          protocol: 'oidc',
          purpose: 'authorization',
        },
      },
    });
  });

  it('records a Flow ConsentRecord when a consent policy step is submitted', async () => {
    const { data: startData } = await startInteraction(
      {
        flow_kind: 'registration',
        client_id: 'client_1',
        requested_scope: 'openid profile',
      },
      consentRuntime
    );
    resetAdapter();
    mockSubmitQueries({
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      currentNodeId: 'consent',
      currentStepId: 'consent:step',
      stepState: 'waiting_input',
      runtimeSnapshot: consentRuntime,
      clientId: 'client_1',
      context: {
        protocol: 'oidc',
        target_type: 'oidc_client',
        target_id: 'client_1',
        client_id: 'client_1',
        requested_scope: ['openid', 'profile'],
      },
    });
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce({
        id: 'policy_registration',
        display_name: 'Registration consent policy',
        description: null,
        is_active: 1,
      })
      .mockResolvedValueOnce({ id: 'version_terms_current', version: '20260701' })
      .mockResolvedValueOnce({
        id: 'policy_registration',
        display_name: 'Registration consent policy',
        description: null,
        is_active: 1,
      })
      .mockResolvedValueOnce({ id: 'version_terms_current', version: '20260701' });
    mocks.coreAdapter.query
      .mockResolvedValueOnce([
        {
          statement_id: 'statement_terms',
          requirement: 'required',
          version_mode: 'latest',
          version_id: null,
          checkbox_mode: 'required',
          checkbox_default_checked: 0,
          binding_type: 'subject',
          binding_value: null,
          evidence_profile: null,
          language_fallback: null,
          display_order: 0,
          slug: 'terms_of_service',
          category: 'terms_of_service',
        },
      ])
      .mockResolvedValueOnce([
        {
          language: 'en',
          title: 'Terms of Service',
          description: '',
          document_url: 'https://example.com/tos',
          inline_content: 'I agree to %link1%.',
        },
      ])
      .mockResolvedValueOnce([
        {
          statement_id: 'statement_terms',
          requirement: 'required',
          version_mode: 'latest',
          version_id: null,
          checkbox_mode: 'required',
          checkbox_default_checked: 0,
          binding_type: 'subject',
          binding_value: null,
          evidence_profile: null,
          language_fallback: null,
          display_order: 0,
          slug: 'terms_of_service',
          category: 'terms_of_service',
        },
      ])
      .mockResolvedValueOnce([
        {
          language: 'en',
          title: 'Terms of Service',
          description: '',
          document_url: 'https://example.com/tos',
          inline_content: 'I agree to %link1%.',
        },
      ]);
    mocks.sessionStore.getSessionRpc.mockResolvedValueOnce({
      userId: 'user_1',
      expiresAt: Date.now() + 60_000,
      createdAt: 1_700_000_000_000,
      data: { authTime: 1_700_000_123 },
    });

    const response = await loginRuntimeInteractionSubmitHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        headers: {
          Cookie: 'authrim_session=sess_runtime_1',
          'User-Agent': 'Vitest',
        },
        body: {
          step_id: 'consent:step',
          node_id: 'consent',
          contract_hash: startData.contract_hash,
          signature: startData.signature,
          input: {
            consent_item_decisions: {
              statement_terms: 'granted',
            },
          },
        },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(200);
    expect(data.completed).toBe(true);
    expect(data.step).toBeNull();
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO consent_records'),
      expect.arrayContaining([
        'tenant_test',
        'user_1',
        'user_1',
        'oidc',
        'terms',
        'client_1',
        null,
        'oidc_client',
        'client_1',
        'subject',
        null,
        'document',
        null,
        'terms_of_service',
        'statement_terms',
        '20260701',
        'policy_registration',
        'flow_login',
        'fv_1',
        'consent',
        'accepted',
      ])
    );
  });

  it('records selected User Decision radio values for SAML attribute release consent', async () => {
    const { data: startData } = await startInteraction(
      {
        flow_kind: 'login',
        saml_sp_id: 'saml_sp_1',
        saml_request_id: 'saml_request_1',
        saml_sp_entity_id: 'https://sp.example.test/metadata',
      },
      consentRuntime
    );
    resetAdapter();
    mockSubmitQueries({
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      currentNodeId: 'consent',
      currentStepId: 'consent:step',
      stepState: 'waiting_input',
      runtimeSnapshot: consentRuntime,
      samlSpId: 'saml_sp_1',
      context: {
        protocol: 'saml',
        target_type: 'saml_sp',
        target_id: 'saml_sp_1',
        saml_sp_id: 'saml_sp_1',
        saml_request_id: 'saml_request_1',
        saml_sp_entity_id: 'https://sp.example.test/metadata',
      },
    });
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce({
        id: 'policy_registration',
        display_name: 'SAML release policy',
        description: null,
        is_active: 1,
      })
      .mockResolvedValueOnce({ id: 'version_saml_current', version: '20260701' })
      .mockResolvedValueOnce({
        id: 'policy_registration',
        display_name: 'SAML release policy',
        description: null,
        is_active: 1,
      })
      .mockResolvedValueOnce({ id: 'version_saml_current', version: '20260701' });
    mocks.coreAdapter.query
      .mockResolvedValueOnce([
        {
          statement_id: 'statement_saml',
          requirement: 'required',
          version_mode: 'latest',
          version_id: null,
          checkbox_mode: 'required',
          checkbox_default_checked: 0,
          binding_type: 'user_decision',
          binding_value: null,
          evidence_profile: null,
          language_fallback: null,
          display_order: 0,
          slug: 'saml_attribute_release_uapprove',
          category: 'saml_attribute_release_confirmation',
          conditional_rules_json: JSON.stringify({
            content_mode: 'radio',
            binding_type: 'user_decision',
            attribute_value_display: 'masked_values',
            content_options: [
              {
                id: 'option-1',
                value: 'once',
                labels: { en: 'Allow once' },
                descriptions: { en: 'Allow this time only.' },
              },
              {
                id: 'option-2',
                value: 'always',
                labels: { en: 'Always allow' },
                descriptions: { en: 'Remember this choice.' },
              },
            ],
          }),
        },
      ])
      .mockResolvedValueOnce([
        {
          language: 'en',
          title: 'SAML attribute release',
          description: '',
          document_url: null,
          inline_content: 'Choose how attributes are released.',
        },
      ])
      .mockResolvedValueOnce([
        {
          statement_id: 'statement_saml',
          requirement: 'required',
          version_mode: 'latest',
          version_id: null,
          checkbox_mode: 'required',
          checkbox_default_checked: 0,
          binding_type: 'user_decision',
          binding_value: null,
          evidence_profile: null,
          language_fallback: null,
          display_order: 0,
          slug: 'saml_attribute_release_uapprove',
          category: 'saml_attribute_release_confirmation',
          conditional_rules_json: JSON.stringify({
            content_mode: 'radio',
            binding_type: 'user_decision',
            attribute_value_display: 'masked_values',
            content_options: [
              {
                id: 'option-1',
                value: 'once',
                labels: { en: 'Allow once' },
                descriptions: { en: 'Allow this time only.' },
              },
              {
                id: 'option-2',
                value: 'always',
                labels: { en: 'Always allow' },
                descriptions: { en: 'Remember this choice.' },
              },
            ],
          }),
        },
      ])
      .mockResolvedValueOnce([
        {
          language: 'en',
          title: 'SAML attribute release',
          description: '',
          document_url: null,
          inline_content: 'Choose how attributes are released.',
        },
      ]);
    mocks.sessionStore.getSessionRpc.mockResolvedValueOnce({
      userId: 'user_1',
      expiresAt: Date.now() + 60_000,
      createdAt: 1_700_000_000_000,
      data: { authTime: 1_700_000_123 },
    });

    const response = await loginRuntimeInteractionSubmitHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        headers: {
          Cookie: 'authrim_session=sess_runtime_1',
          'User-Agent': 'Vitest',
        },
        body: {
          step_id: 'consent:step',
          node_id: 'consent',
          contract_hash: startData.contract_hash,
          signature: startData.signature,
          input: {
            consent_item_decisions: {
              statement_saml: 'selected',
            },
            consent_item_selected_values: {
              statement_saml: 'always',
            },
          },
        },
      })
    );

    expect(response.status).toBe(200);
    const insertCall = mocks.coreAdapter.execute.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO consent_records')
    );
    expect(insertCall).toBeTruthy();
    const values = insertCall?.[1] as unknown[];
    expect(values[4]).toBe('saml');
    expect(values[5]).toBe('attribute_release');
    expect(values[8]).toBe('saml_sp');
    expect(values[10]).toBe('user_decision');
    expect(values[21]).toBe('always');
    expect(values[22]).toBe('always');
    expect(values[23]).toBe(JSON.stringify(['always']));
    expect(JSON.parse(String(values[30]))).toMatchObject({
      content_mode: 'radio',
      selected_value: 'always',
      attribute_value_display: 'masked_values',
      saml_sp_entity_id: 'https://sp.example.test/metadata',
    });
  });

  it('skips a consent policy step when every consent item already has an active record', async () => {
    const { data: startData } = await startInteraction(
      {
        flow_kind: 'login',
        client_id: 'client_1',
        requested_scope: 'openid profile',
      },
      acceptedConsentRuntime
    );
    resetAdapter();
    mockSubmitQueries({
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      currentNodeId: 'auth',
      currentStepId: 'auth:step',
      stepState: 'waiting_input',
      runtimeSnapshot: acceptedConsentRuntime,
      editorSnapshot: acceptedConsentEditor,
      clientId: 'client_1',
      context: {
        protocol: 'oidc',
        target_type: 'oidc_client',
        target_id: 'client_1',
        client_id: 'client_1',
        requested_scope: ['openid', 'profile'],
      },
    });
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce({
        id: 'policy_registration',
        display_name: 'Registration consent policy',
        description: null,
        is_active: 1,
      })
      .mockResolvedValueOnce({ id: 'version_terms_current', version: '20260701' })
      .mockResolvedValueOnce({ id: 'existing_consent_record' });
    mocks.coreAdapter.query
      .mockResolvedValueOnce([
        {
          statement_id: 'statement_terms',
          requirement: 'required',
          version_mode: 'latest',
          version_id: null,
          checkbox_mode: 'required',
          checkbox_default_checked: 0,
          binding_type: 'subject',
          binding_value: null,
          evidence_profile: null,
          language_fallback: null,
          display_order: 0,
          slug: 'terms_of_service',
          category: 'terms_of_service',
        },
      ])
      .mockResolvedValueOnce([
        {
          language: 'en',
          title: 'Terms of Service',
          description: '',
          document_url: 'https://example.com/tos',
          inline_content: 'I agree to %link1%.',
        },
      ]);
    mocks.sessionStore.getSessionRpc.mockResolvedValueOnce({
      userId: 'user_1',
      expiresAt: Date.now() + 60_000,
      createdAt: 1_700_000_000_000,
      data: { authTime: 1_700_000_123 },
    });

    const response = await loginRuntimeInteractionSubmitHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        headers: { Cookie: 'authrim_session=sess_runtime_1' },
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
    expect(data.completed).toBe(true);
    expect(data.step).toBeNull();
    expect(mocks.coreAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO consent_records'),
      expect.anything()
    );
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
