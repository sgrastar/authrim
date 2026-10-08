import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { DatabaseAdapter, Env, FlowRuntimeContract } from '@authrim/ar-lib-core';
import {
  cleanupExpiredFlowInteractions,
  clearLoginRuntimeFlowVersionCacheForTests,
  loginRuntimeEmailVerificationChallengeHandler,
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
  const adminAdapter = {
    query: vi.fn(),
    queryOne: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(),
  };
  const sessionStore = {
    getSessionRpc: vi.fn(),
  };
  const challengeStore = {
    getChallengeRpc: vi.fn(),
    storeChallengeRpc: vi.fn(),
  };
  const runtimeUsers = {
    findById: vi.fn(),
  };
  const idQueue = ['interaction_1', 'step_1', 'audit_1', 'audit_2', 'step_2', 'audit_3'];

  return {
    coreAdapter,
    adminAdapter,
    sessionStore,
    challengeStore,
    runtimeUsers,
    resolveRuntimeIdentityMappingBinding: vi.fn(),
    idQueue,
    consumeAuthorizationChallengeContinuation: vi.fn(),
    readAuthorizationChallengeFreshness: vi.fn(),
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
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: {} })),
    CanonicalRuntimeUserStore: class {
      findById(...args: unknown[]) {
        return mocks.runtimeUsers.findById(...args);
      }
    },
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
    resolveRuntimeIdentityMappingBinding: mocks.resolveRuntimeIdentityMappingBinding,
  };
});

vi.mock('../direct-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../direct-auth')>();
  return {
    consumeAuthorizationChallengeContinuation: mocks.consumeAuthorizationChallengeContinuation,
    readAuthorizationChallengeFreshness: mocks.readAuthorizationChallengeFreshness,
    isProofOlderThanChallengeRequirement: actual.isProofOlderThanChallengeRequirement,
    reauthProofFromRecord: actual.reauthProofFromRecord,
  };
});

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

const screenRuntime: FlowRuntimeContract = {
  flow_kind: 'registration',
  ui: {
    steps: [
      {
        id: 'profile:step',
        source_node_id: 'profile',
        component: 'screen',
        render: true,
        config: {
          screen_ref: 'registration',
        },
      },
    ],
  },
};

const authScreenConsentRuntime: FlowRuntimeContract = {
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
          screen_ref: 'login',
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

const explicitEmailVerificationRuntime: FlowRuntimeContract = {
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
        id: 'email-verify:step',
        source_node_id: 'email-verify',
        component: 'email_verification',
        render: false,
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

const explicitEmailVerificationEditor = {
  nodes: [
    { id: 'auth', type: 'authentication' },
    { id: 'email-verify', type: 'email_verification' },
    { id: 'complete', type: 'complete' },
  ],
  edges: [
    {
      id: 'edge_auth_email_verify',
      source: 'auth',
      target: 'email-verify',
      source_handle: 'mail_otp',
    },
    {
      id: 'edge_email_verify_complete',
      source: 'email-verify',
      target: 'complete',
      source_handle: 'verified',
    },
  ],
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

const protocolBranchRuntime: FlowRuntimeContract = {
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
        id: 'protocol-condition:step',
        source_node_id: 'protocol-condition',
        component: 'condition',
        render: false,
        config: {
          conditions: {
            rows: [
              {
                id: 'saml',
                condition: { type: 'protocol', value: 'saml' },
                output_handle: 'saml',
              },
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
      ...mixedProtocolCompletionRuntime.ui.steps.filter(
        (step) => step.source_node_id !== 'session-check'
      ),
    ],
  },
};

const protocolBranchEditor = {
  nodes: [
    { id: 'entry', type: 'entry' },
    { id: 'protocol-condition', type: 'condition' },
    { id: 'saml-complete', type: 'complete' },
    { id: 'oidc-complete', type: 'complete' },
  ],
  edges: [
    {
      id: 'entry-condition',
      source: 'entry',
      source_handle: 'next',
      target: 'protocol-condition',
    },
    {
      id: 'condition-saml',
      source: 'protocol-condition',
      source_handle: 'saml',
      target: 'saml-complete',
    },
    {
      id: 'condition-oidc',
      source: 'protocol-condition',
      source_handle: 'oidc',
      target: 'oidc-complete',
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
    header: vi.fn(),
  } as unknown as RuntimeContext;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const data: unknown = await response.json();
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

/** The statements run inside the interaction's transactions since the last reset. */
const txExecuteCalls: Array<[string, unknown[] | undefined]> = [];

function resetAdapter() {
  vi.clearAllMocks();
  txExecuteCalls.length = 0;
  mocks.coreAdapter.query.mockReset();
  mocks.coreAdapter.queryOne.mockReset();
  mocks.coreAdapter.execute.mockReset();
  mocks.coreAdapter.transaction.mockReset();
  mocks.coreAdapter.batch.mockReset();
  mocks.coreAdapter.isHealthy.mockReset();
  mocks.coreAdapter.getType.mockReset();
  mocks.coreAdapter.close.mockReset();
  mocks.adminAdapter.query.mockReset();
  mocks.adminAdapter.queryOne.mockReset();
  mocks.adminAdapter.execute.mockReset();
  mocks.sessionStore.getSessionRpc.mockReset();
  mocks.challengeStore.getChallengeRpc.mockReset();
  mocks.challengeStore.storeChallengeRpc.mockReset();
  mocks.runtimeUsers.findById.mockReset();
  mocks.consumeAuthorizationChallengeContinuation.mockReset();
  mocks.readAuthorizationChallengeFreshness.mockReset();
  mocks.readAuthorizationChallengeFreshness.mockResolvedValue(null);
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
        execute: vi.fn(async (sql: string, params?: unknown[]) => {
          txExecuteCalls.push([sql, params]);
          return { success: true, rowsAffected: 1 };
        }),
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
  expiresAt: number;
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
  userId?: string | null;
}) {
  const currentNodeId = input.currentNodeId ?? 'entry';
  const currentStepId = input.currentStepId ?? 'entry:step';
  mocks.coreAdapter.queryOne
    .mockResolvedValueOnce({
      id: 'interaction_1',
      flow_id: 'flow_login',
      flow_version_id: 'fv_1',
      user_id: input.userId ?? null,
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
      expires_at: input.expiresAt,
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

  it('never coerces VC server-side flow kinds into a login flow', async () => {
    const response = await loginRuntimeInteractionStartHandler(
      createContext({ body: { flow_kind: 'credential_issuance' } })
    );
    const data = await readJson(response);
    expect(response.status).toBe(400);
    expect(data.error).toBe('unsupported_flow_kind');
    expect(mocks.coreAdapter.queryOne).not.toHaveBeenCalled();
    expect(mocks.coreAdapter.transaction).not.toHaveBeenCalled();
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

  it.each([
    {
      protocol: 'oidc',
      body: { flow_kind: 'login', client_id: 'client_1' },
      expectedStep: 'oidc-complete',
    },
    {
      protocol: 'saml',
      body: { flow_kind: 'login', saml_sp_id: 'saml_sp_1' },
      expectedStep: 'saml-complete',
    },
  ])(
    'routes a $protocol request through the matching protocol branch',
    async ({ body, expectedStep }) => {
      const { response, data } = await startInteraction(
        body,
        protocolBranchRuntime,
        protocolBranchEditor
      );

      expect(response.status).toBe(200);
      expect(data.interaction).toMatchObject({
        current_node_id: expectedStep,
        current_step_id: `${expectedStep}:step`,
      });
    }
  );

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
    expect(data.error).toBe('authorization_request_expired');
    expect(data.error_code).toBe('AR_FLOW_AUTH_REQUEST_EXPIRED');
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

  it('creates an EVP nonce only for a mail-OTP branch with explicit email verification', async () => {
    const { data: startData } = await startInteraction(
      { flow_kind: 'login' },
      explicitEmailVerificationRuntime,
      explicitEmailVerificationEditor
    );
    const interaction = startData.interaction as Record<string, unknown>;
    resetAdapter();
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce({
        id: 'interaction_1',
        flow_id: 'flow_login',
        flow_version_id: 'fv_1',
        user_id: null,
        client_id: null,
        saml_sp_id: null,
        state: 'active',
        current_node_id: 'auth',
        current_step_id: 'auth:step',
        context_json: JSON.stringify({
          protocol: 'oidc',
          target_type: 'tenant',
          target_id: null,
          requested_scope: ['openid'],
          locale: 'en',
        }),
        contract_hash: startData.contract_hash,
        signature: startData.signature,
        expires_at: interaction.expires_at,
      })
      .mockResolvedValueOnce({
        id: 'fv_1',
        flow_id: 'flow_login',
        schema_version: 'authrim.login_ui.contract.v1',
        runtime_snapshot_json: JSON.stringify(explicitEmailVerificationRuntime),
        editor_snapshot_json: JSON.stringify(explicitEmailVerificationEditor),
        published_at: 1782770000,
      });

    const response = await loginRuntimeEmailVerificationChallengeHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        url: 'https://api.example.com/api/v1/login/interactions/interaction_1/email-verification/challenge',
        headers: { origin: 'https://login.example.com' },
        body: {
          step_id: 'auth:step',
          contract_hash: startData.contract_hash,
          signature: startData.signature,
        },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(200);
    expect(data).toMatchObject({
      available: true,
      interaction_id: 'interaction_1',
      step_id: 'auth:step',
      expires_in: expect.any(Number),
      nonce: expect.any(String),
      challenge_id: expect.any(String),
    });
    expect(mocks.challengeStore.storeChallengeRpc).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_test',
        type: 'email_verification_protocol',
        challenge: data.nonce,
        metadata: expect.objectContaining({
          interaction_id: 'interaction_1',
          source_step_id: 'auth:step',
          verification_step_id: 'email-verify:step',
          expected_origin: 'https://login.example.com',
          contract_hash: startData.contract_hash,
        }),
      })
    );
  });

  it('does not create an EVP nonce when the Flow has no explicit email-verification step', async () => {
    const { data: startData } = await startInteraction();
    const interaction = startData.interaction as Record<string, unknown>;
    resetAdapter();
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce({
        id: 'interaction_1',
        flow_id: 'flow_login',
        flow_version_id: 'fv_1',
        user_id: null,
        client_id: null,
        saml_sp_id: null,
        state: 'active',
        current_node_id: 'auth',
        current_step_id: 'auth:step',
        context_json: JSON.stringify({
          protocol: 'oidc',
          target_type: 'tenant',
          target_id: null,
          requested_scope: ['openid'],
          locale: 'en',
        }),
        contract_hash: startData.contract_hash,
        signature: startData.signature,
        expires_at: interaction.expires_at,
      })
      .mockResolvedValueOnce({
        id: 'fv_1',
        flow_id: 'flow_login',
        schema_version: 'authrim.login_ui.contract.v1',
        runtime_snapshot_json: JSON.stringify(runtime),
        editor_snapshot_json: null,
        published_at: 1782770000,
      });

    const response = await loginRuntimeEmailVerificationChallengeHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        body: {
          step_id: 'auth:step',
          contract_hash: startData.contract_hash,
          signature: startData.signature,
        },
      })
    );

    await expect(response.json()).resolves.toEqual({ available: false });
    expect(mocks.challengeStore.storeChallengeRpc).not.toHaveBeenCalled();
  });

  it('rejects a manually selected verified handle without email authentication', async () => {
    const { data: startData } = await startInteraction(
      { flow_kind: 'login' },
      explicitEmailVerificationRuntime,
      explicitEmailVerificationEditor
    );
    const interaction = startData.interaction as Record<string, unknown>;
    resetAdapter();
    mockSubmitQueries({
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      expiresAt: Number(interaction.expires_at),
      currentNodeId: 'email-verify',
      currentStepId: 'email-verify:step',
      stepState: 'waiting_input',
      runtimeSnapshot: explicitEmailVerificationRuntime,
      editorSnapshot: explicitEmailVerificationEditor,
    });

    const response = await loginRuntimeInteractionSubmitHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        body: {
          step_id: 'email-verify:step',
          node_id: 'email-verify',
          selected_handle: 'verified',
          contract_hash: startData.contract_hash,
          signature: startData.signature,
        },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(403);
    expect(data).toMatchObject({
      error: 'email_verification_required',
      error_code: 'AR_FLOW_EMAIL_VERIFICATION_REQUIRED',
      category: 'security_error',
    });
  });

  it('accepts a recent verified-email session bound to the same runtime interaction', async () => {
    const { data: startData } = await startInteraction(
      { flow_kind: 'login' },
      explicitEmailVerificationRuntime,
      explicitEmailVerificationEditor
    );
    const interaction = startData.interaction as Record<string, unknown>;
    resetAdapter();
    mockSubmitQueries({
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      expiresAt: Number(interaction.expires_at),
      currentNodeId: 'email-verify',
      currentStepId: 'email-verify:step',
      stepState: 'waiting_input',
      runtimeSnapshot: explicitEmailVerificationRuntime,
      editorSnapshot: explicitEmailVerificationEditor,
    });
    mocks.sessionStore.getSessionRpc.mockResolvedValue({
      id: 'sess_runtime_1',
      userId: 'user_1',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      data: {
        amr: ['email_verification_protocol'],
        authTime: Math.floor(Date.now() / 1000),
        runtime_interaction_id: 'interaction_1',
      },
    });
    mocks.runtimeUsers.findById.mockResolvedValueOnce({
      id: 'user_1',
      active: 1,
      email: 'user@example.com',
      email_verified: 1,
    });

    const response = await loginRuntimeInteractionSubmitHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        headers: { Cookie: 'authrim_session=sess_runtime_1' },
        body: {
          step_id: 'email-verify:step',
          node_id: 'email-verify',
          selected_handle: 'verified',
          contract_hash: startData.contract_hash,
          signature: startData.signature,
        },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(200);
    expect(data.completed).toBe(true);
    expect(mocks.runtimeUsers.findById).toHaveBeenCalledWith('user_1', {
      includeInactive: true,
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

  it('rebuilds and persists a resumed interaction contract for the requested locale', async () => {
    const { data: started } = await startInteraction({ flow_kind: 'login', locale: 'en' });
    const startedInteraction = started.interaction as {
      id: string;
      flow_id: string;
      flow_version_id: string;
      current_node_id: string;
      current_step_id: string;
      expires_at: number;
    };
    const startedContractHash = String(started.contract_hash);
    const startedSignature = String(started.signature);
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce({
        id: startedInteraction.id,
        flow_id: startedInteraction.flow_id,
        flow_version_id: startedInteraction.flow_version_id,
        client_id: null,
        saml_sp_id: null,
        state: 'active',
        current_node_id: startedInteraction.current_node_id,
        current_step_id: startedInteraction.current_step_id,
        context_json: JSON.stringify({
          protocol: 'direct',
          target_type: 'tenant',
          target_id: null,
          locale: 'en',
        }),
        contract_hash: startedContractHash,
        signature: startedSignature,
        expires_at: startedInteraction.expires_at,
      })
      .mockResolvedValueOnce({
        id: 'fv_1',
        flow_id: 'flow_login',
        schema_version: 'authrim.login_ui.contract.v1',
        runtime_snapshot_json: JSON.stringify(runtime),
        editor_snapshot_json: null,
        published_at: 1782770000,
      });

    const response = await loginRuntimeInteractionStartHandler(
      createContext({
        body: {
          resume_interaction_id: startedInteraction.id,
          contract_hash: startedContractHash,
          signature: startedSignature,
          locale: 'ko',
        },
      })
    );
    const resumed = await readJson(response);

    expect(response.status).toBe(200);
    expect(resumed.resumed).toBe(true);
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('SET context_json = ?'),
      expect.arrayContaining([expect.stringContaining('"locale":"ko"')])
    );
  });

  it('hydrates screen steps with the active screen snapshot', async () => {
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
        runtime_snapshot_json: JSON.stringify(screenRuntime),
        editor_snapshot_json: null,
        published_at: 1782770000,
      })
      .mockResolvedValueOnce({
        id: 'profile_1',
        screen_key: 'registration',
        display_name: 'Registration',
        description: 'Registration screen',
        screen_kind: 'registration',
        fields_json: JSON.stringify([
          {
            field: 'email',
            label: 'Email',
            required: true,
            block_type: 'identity_field',
          },
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
            description: '標準の新規登録スクリーンです。',
            fields: {
              'auth.mail_otp-1': {
                label: '認証コードを送信',
                text: 'メールアドレスにコードを送信します。',
              },
            },
          },
        }),
        settings_json: JSON.stringify({ canvas_layout: 'narrow' }),
      });
    mocks.coreAdapter.query.mockResolvedValueOnce([
      { field_key: 'email', registration_required: 0 },
    ]);

    const response = await loginRuntimeInteractionStartHandler(
      createContext({ body: { flow_kind: 'registration', requested_locale: 'ja' } })
    );
    const data = await readJson(response);
    const runtimeData = data.contract as FlowRuntimeContract;

    expect(response.status).toBe(200);
    expect(runtimeData.ui.steps[0].config).toMatchObject({
      screen_ref: 'registration',
      screen: {
        id: 'profile_1',
        screen_key: 'registration',
        display_name: '新規登録',
        description: '標準の新規登録スクリーンです。',
        fields: [
          {
            field: 'email',
            label: 'Email',
            required: false,
            block_type: 'identity_field',
          },
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

  it('reconciles every registration identity field with the active schema requirement', async () => {
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
        runtime_snapshot_json: JSON.stringify(screenRuntime),
        editor_snapshot_json: null,
        published_at: 1782770000,
      })
      .mockResolvedValueOnce({
        id: 'profile_1',
        screen_key: 'registration_custom',
        display_name: 'Registration',
        description: 'Registration screen',
        screen_kind: 'registration',
        fields_json: JSON.stringify([
          {
            field: 'field.canonical.email',
            label: 'Email',
            required: false,
            block_type: 'identity_field',
          },
          {
            field: 'department',
            label: 'Department',
            required: false,
            block_type: 'identity_field',
          },
          {
            field: 'locale',
            label: 'Locale',
            required: true,
            block_type: 'identity_field',
          },
          {
            field: 'unmanaged',
            label: 'Unmanaged',
            required: true,
            block_type: 'identity_field',
          },
        ]),
        localizations_json: JSON.stringify({}),
        settings_json: JSON.stringify({ canvas_layout: 'narrow' }),
      });
    mocks.coreAdapter.query.mockResolvedValueOnce([
      { field_key: 'email', registration_required: 1 },
      { field_key: 'department', registration_required: 1 },
      { field_key: 'locale', registration_required: 0 },
    ]);

    const response = await loginRuntimeInteractionStartHandler(
      createContext({ body: { flow_kind: 'registration' } })
    );
    const data = await readJson(response);
    const runtimeData = data.contract as FlowRuntimeContract;

    expect(response.status).toBe(200);
    expect(runtimeData.ui.steps[0].config).toMatchObject({
      screen: {
        fields: [
          { field: 'field.canonical.email', required: true },
          { field: 'department', required: true },
          { field: 'locale', required: false },
          { field: 'unmanaged', required: true },
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
        runtime_snapshot_json: JSON.stringify(authScreenConsentRuntime),
        editor_snapshot_json: null,
        published_at: 1782770000,
      })
      .mockResolvedValueOnce({
        id: 'profile_login',
        screen_key: 'login',
        display_name: 'Login',
        description: 'Login form',
        screen_kind: 'login',
        fields_json: JSON.stringify([
          {
            field: 'auth.passkey',
            label: 'Sign in with Passkey',
            required: false,
            block_type: 'auth_widget',
            auth_method: 'passkey',
          },
          {
            field: 'divider.or',
            label: 'or',
            required: false,
            block_type: 'divider',
            text: 'or',
          },
          {
            field: 'divider.other_accounts',
            label: 'Continue with another account',
            required: false,
            block_type: 'divider',
            text: 'Continue with another account',
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
      screen_ref: 'login',
      screen: {
        id: 'profile_login',
        screen_key: 'login',
        fields: [
          {
            block_type: 'auth_widget',
            auth_method: 'passkey',
          },
          {
            block_type: 'divider',
            display_condition: { mode: 'feature_enabled', feature: 'mail_otp' },
          },
          {
            block_type: 'divider',
            display_condition: { mode: 'feature_enabled', feature: 'external_idp' },
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

  it('hydrates built-in screens from the default system seed when initial tenant screens are missing', async () => {
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
        runtime_snapshot_json: JSON.stringify({
          flow_kind: 'login',
          ui: {
            steps: [
              {
                id: 'auth:step',
                source_node_id: 'auth',
                component: 'authentication_method_selector',
                render: true,
                config: {
                  screen_ref: 'login',
                },
              },
            ],
          },
        } satisfies FlowRuntimeContract),
        editor_snapshot_json: null,
        published_at: 1782770000,
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'screen-login-default',
        screen_key: 'login',
        display_name: 'Login',
        description: 'Default login screen.',
        screen_kind: 'login',
        fields_json: JSON.stringify([
          {
            field: 'auth.passkey',
            label: 'Sign in with Passkey',
            required: false,
            block_type: 'auth_widget',
            auth_method: 'passkey',
          },
        ]),
        localizations_json: JSON.stringify({}),
        settings_json: JSON.stringify({ canvas_layout: 'narrow' }),
      });

    const response = await loginRuntimeInteractionStartHandler(
      createContext({ body: { flow_kind: 'login' } })
    );
    const data = await readJson(response);
    const runtimeData = data.contract as FlowRuntimeContract;

    expect(response.status).toBe(200);
    expect(runtimeData.ui.steps[0].config).toMatchObject({
      screen_ref: 'login',
      screen: {
        id: 'screen-login-default',
        screen_key: 'login',
        fields: [
          {
            block_type: 'auth_widget',
            auth_method: 'passkey',
          },
        ],
      },
    });
    expect(mocks.coreAdapter.queryOne).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('AND is_system = 1'),
      ['default', 'login', 'login']
    );
  });

  it('hydrates Destination Profile fields and records the selected optional OIDC claims', async () => {
    mockStartQueries(consentRuntime);
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce({
        identity_mapping: JSON.stringify({ destinationProfileId: 'destination_oidc_1' }),
      })
      .mockResolvedValueOnce({
        id: 'policy_registration',
        display_name: 'Authorization consent',
        description: null,
        is_active: 1,
      });
    mocks.coreAdapter.query.mockResolvedValueOnce([]);
    mocks.adminAdapter.queryOne.mockResolvedValueOnce({
      profile_id: 'destination_oidc_1',
      destination_type: 'oidc',
      version_id: 'destination_oidc_version_1',
      schema_json: JSON.stringify({
        claims: [
          { claimName: 'sub', label: 'Subject', required: true, requiredScopes: ['openid'] },
          { claimName: 'name', label: 'Name', required: false, requiredScopes: ['profile'] },
          { claimName: 'email', label: 'Email', required: false, requiredScopes: ['email'] },
        ],
      }),
    });

    const startResponse = await loginRuntimeInteractionStartHandler(
      createContext({
        env: { DB_ADMIN: mocks.adminAdapter as never },
        body: {
          flow_kind: 'login',
          client_id: 'client_1',
          requested_scope: ['openid', 'profile'],
        },
      })
    );
    const startData = await readJson(startResponse);
    const startContract = startData.contract as FlowRuntimeContract;
    expect(startResponse.status).toBe(200);
    expect(startContract.ui.steps[0]?.content?.destination_field_consent).toMatchObject({
      profile_id: 'destination_oidc_1',
      profile_version_id: 'destination_oidc_version_1',
      fields: [
        expect.objectContaining({ key: 'sub', required: true }),
        expect.objectContaining({ key: 'name', required: false }),
      ],
    });

    resetAdapter();
    mockSubmitQueries({
      expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
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
        identity_mapping: JSON.stringify({ destinationProfileId: 'destination_oidc_1' }),
      })
      .mockResolvedValueOnce({
        id: 'policy_registration',
        display_name: 'Authorization consent',
        description: null,
        is_active: 1,
      })
      .mockResolvedValueOnce({
        id: 'policy_registration',
        display_name: 'Authorization consent',
        description: null,
        is_active: 1,
      });
    mocks.coreAdapter.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    mocks.adminAdapter.queryOne.mockResolvedValueOnce({
      profile_id: 'destination_oidc_1',
      destination_type: 'oidc',
      version_id: 'destination_oidc_version_1',
      schema_json: JSON.stringify({
        claims: [
          { claimName: 'sub', label: 'Subject', required: true, requiredScopes: ['openid'] },
          { claimName: 'name', label: 'Name', required: false, requiredScopes: ['profile'] },
        ],
      }),
    });
    mocks.sessionStore.getSessionRpc.mockResolvedValueOnce({
      userId: 'user_1',
      expiresAt: Date.now() + 60_000,
      createdAt: 1_700_000_000_000,
      data: { authTime: 1_700_000_123 },
    });

    const submitResponse = await loginRuntimeInteractionSubmitHandler(
      createContext({
        env: { DB_ADMIN: mocks.adminAdapter as never },
        params: { interaction_id: 'interaction_1' },
        headers: { Cookie: 'authrim_session=sess_runtime_1', 'User-Agent': 'Vitest' },
        body: {
          step_id: 'consent:step',
          node_id: 'consent',
          selected_handle: 'accepted',
          contract_hash: startData.contract_hash,
          signature: startData.signature,
          input: {
            destination_field_decisions: { sub: true, name: false },
          },
        },
      })
    );

    expect(submitResponse.status).toBe(200);
    expect(mocks.coreAdapter.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO consent_records'),
      expect.arrayContaining([
        'destination_field_mapping_set',
        'destination_oidc_1',
        'destination_profile:destination_oidc_1',
        'destination_oidc_version_1',
        JSON.stringify(['sub']),
      ])
    );
  });

  it('hydrates OIDC consent from the Mapping Set active Destination Profile', async () => {
    mockStartQueries(consentRuntime);
    mocks.coreAdapter.queryOne
      .mockResolvedValueOnce({
        identity_mapping: JSON.stringify({
          fieldMappingSetId: 'mapping_set_1',
          destinationProfileId: 'stale_destination_profile',
        }),
      })
      .mockResolvedValueOnce({
        id: 'policy_registration',
        display_name: 'Authorization consent',
        description: null,
        is_active: 1,
      });
    mocks.coreAdapter.query.mockResolvedValueOnce([]);
    mocks.resolveRuntimeIdentityMappingBinding.mockResolvedValueOnce({
      destinationProfileId: 'active_destination_profile',
      destinationProfileIds: ['active_destination_profile'],
    });
    mocks.adminAdapter.queryOne.mockResolvedValueOnce({
      profile_id: 'active_destination_profile',
      destination_type: 'oidc',
      version_id: 'active_destination_profile_v2',
      schema_json: JSON.stringify({
        claims: [{ claimName: 'sub', label: 'Subject', required: true }],
      }),
    });

    const response = await loginRuntimeInteractionStartHandler(
      createContext({
        env: { DB_ADMIN: mocks.adminAdapter as never },
        body: {
          flow_kind: 'login',
          client_id: 'client_1',
          requested_scope: ['openid'],
        },
      })
    );
    const data = await readJson(response);
    const contract = data.contract as FlowRuntimeContract;

    expect(response.status).toBe(200);
    expect(mocks.resolveRuntimeIdentityMappingBinding).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        protocol: 'oidc',
        fieldMappingSetId: 'mapping_set_1',
      })
    );
    expect(contract.ui.steps[0]?.content?.destination_field_consent).toMatchObject({
      profile_id: 'active_destination_profile',
      profile_version_id: 'active_destination_profile_v2',
    });
  });

  it('hydrates SAML destination consent from the per-SP release policy', async () => {
    mockStartQueries(consentRuntime);
    mocks.coreAdapter.queryOne.mockResolvedValueOnce({
      id: 'policy_registration',
      display_name: 'SAML release consent',
      description: null,
      is_active: 1,
    });
    mocks.coreAdapter.query
      .mockResolvedValueOnce([
        {
          id: 'saml_sp_1',
          config_json: JSON.stringify({
            entityId: 'https://sp.example.test/metadata',
            attributeReleaseConsent: { enabled: true, mode: 'until_attributes_change' },
            identityMapping: {
              destinationProfileId: 'destination_saml_1',
              destinationFieldPolicies: {
                mail: 'required',
                displayName: 'optional',
                eduPersonAffiliation: 'hidden',
              },
            },
          }),
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.adminAdapter.queryOne.mockResolvedValueOnce({
      profile_id: 'destination_saml_1',
      destination_type: 'saml',
      version_id: 'destination_saml_version_1',
      schema_json: JSON.stringify({
        attributes: [
          { name: 'mail', label: 'Email', required: false, nullable: true },
          { name: 'displayName', label: 'Display name', required: true, nullable: false },
          {
            name: 'eduPersonAffiliation',
            label: 'Affiliation',
            required: true,
            nullable: false,
          },
        ],
      }),
    });

    const response = await loginRuntimeInteractionStartHandler(
      createContext({
        env: { DB_ADMIN: mocks.adminAdapter as never },
        body: {
          flow_kind: 'login',
          saml_sp_id: 'saml_sp_1',
          saml_sp_entity_id: 'https://sp.example.test/metadata',
        },
      })
    );
    const data = await readJson(response);
    const runtimeData = data.contract as FlowRuntimeContract;
    const destinationConsent = runtimeData.ui.steps[0]?.content?.destination_field_consent as
      | { fields: Array<{ key: string }>; consent_version: string }
      | undefined;

    expect(response.status).toBe(200);
    expect(runtimeData.ui.steps[0]?.content?.destination_field_consent).toMatchObject({
      profile_id: 'destination_saml_1',
      profile_version_id: 'destination_saml_version_1',
      destination_type: 'saml',
      consent_mode: 'until_attributes_change',
      fields: [
        expect.objectContaining({ key: 'mail', required: true, nullable: false }),
        expect.objectContaining({ key: 'displayName', required: false, nullable: true }),
      ],
    });
    expect(destinationConsent?.fields.map((field) => field.key)).not.toContain(
      'eduPersonAffiliation'
    );
    expect(destinationConsent?.consent_version).not.toBe('destination_saml_version_1');
  });

  it('advances a signed active interaction to the next runtime step', async () => {
    const { data: startData } = await startInteraction();
    resetAdapter();
    mockSubmitQueries({
      expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
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

  it('uses editor edge handles after the clock advances without changing the signed expiry', async () => {
    const startedAt = Date.UTC(2026, 8, 22);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    try {
      const { data: startData } = await startInteraction();
      clock.mockReturnValue(startedAt + 2000);
      resetAdapter();
      mockSubmitQueries({
        expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
        contractHash: String(startData.contract_hash),
        signature: String(startData.signature),
        currentNodeId: 'auth',
        currentStepId: 'auth:step',
        stepState: 'waiting_input',
        runtimeSnapshot: branchingRuntime,
        editorSnapshot: branchingEditor,
      });

      mocks.sessionStore.getSessionRpc.mockResolvedValue({
        userId: 'user_1',
        expiresAt: startedAt + 60_000,
        createdAt: startedAt - 1000,
        data: { authTime: Math.floor(startedAt / 1000) },
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
    } finally {
      clock.mockRestore();
    }
  });

  it('skips implicit account action nodes instead of returning a Continue step', async () => {
    const { data: startData } = await startInteraction(
      { flow_kind: 'registration', client_id: 'client_1' },
      implicitAccountActionRuntime
    );
    resetAdapter();
    mockSubmitQueries({
      expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
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
        started_at_ms: Date.now() - 1000,
      },
    });

    mocks.sessionStore.getSessionRpc.mockResolvedValue({
      userId: 'user_1',
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
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
      expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
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
      expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
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
      expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      currentNodeId: 'session-check',
      currentStepId: 'session-check:step',
      stepState: 'pending',
      runtimeSnapshot: sessionCheckRuntime,
      editorSnapshot: sessionCheckEditor,
    });
    mocks.sessionStore.getSessionRpc.mockResolvedValue({
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

  it.each([
    ['older than', 1_700_000_124_000, 'auth:step', undefined],
    ['newer than', 1_700_000_122_000, null, 1_700_000_123_000],
    // A session that did not record when it was proven cannot show it came after the request.
    ['of unknown proof time, after', 1_700_000_100_000, 'auth:step', undefined],
    // An external IdP login that was not asked to renew proves no re-authentication.
    ['from an unrenewed external login', 1_700_000_100_000, 'auth:step', 'external'],
    ['from a renewed external login', 1_700_000_100_000, null, 'external-renewed'],
    ['unreadable for', new Error('challenge store unavailable'), 'auth:step', undefined],
    // Within the same second, the session's proof time in milliseconds decides.
    ['proven just before', 1_700_000_123_500, 'auth:step', 1_700_000_123_400],
    ['proven just after', 1_700_000_123_500, null, 1_700_000_123_600],
  ] as const)(
    'routes a session %s a re-authentication request accordingly',
    async (_label, reauthIssuedAt, nextStepId, provenAt) => {
      const { data: startData } = await startInteraction(
        { flow_kind: 'login' },
        sessionCheckRuntime
      );
      resetAdapter();
      mockSubmitQueries({
        expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
        contractHash: String(startData.contract_hash),
        signature: String(startData.signature),
        currentNodeId: 'session-check',
        currentStepId: 'session-check:step',
        stepState: 'pending',
        runtimeSnapshot: sessionCheckRuntime,
        editorSnapshot: sessionCheckEditor,
        context: { authorization_challenge_id: 'reauth_challenge_1' },
      });
      if (reauthIssuedAt instanceof Error) {
        mocks.readAuthorizationChallengeFreshness.mockRejectedValue(reauthIssuedAt);
      } else {
        mocks.readAuthorizationChallengeFreshness.mockResolvedValue(
          reauthIssuedAt === null ? null : { kind: 'reauth', issuedAt: reauthIssuedAt }
        );
      }
      mocks.consumeAuthorizationChallengeContinuation.mockResolvedValue({
        redirectUrl: 'https://rp.example.com/callback?code=abc',
      });
      mocks.sessionStore.getSessionRpc.mockResolvedValue({
        userId: 'user_1',
        expiresAt: Date.now() + 60_000,
        createdAt: 1_700_000_000_000,
        data: {
          amr: typeof provenAt === 'string' ? ['external_idp'] : ['passkey'],
          authTime: 1_700_000_123,
          ...(typeof provenAt === 'number' ? { proven_at: provenAt } : {}),
          ...(provenAt === 'external-renewed'
            ? { reauth_proven_amr: ['external_idp'], reauth_proven_at: 1_700_000_123_000 }
            : {}),
        },
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

      // A request that cannot be read is asked for again, not decided on.
      expect(response.status).toBe(reauthIssuedAt instanceof Error ? 503 : 200);
      expect(mocks.readAuthorizationChallengeFreshness).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        'reauth_challenge_1'
      );
      if (reauthIssuedAt instanceof Error) {
        expect(data.error).toBe('temporarily_unavailable');
      } else if (nextStepId) {
        expect(data.completed).toBe(false);
        expect(data.step).toMatchObject({ id: nextStepId });
      } else {
        expect(data.completed).toBe(true);
        expect(data.step).toBeNull();
      }
    }
  );

  it('prefers the completion branch matching the active protocol when handles overlap', async () => {
    const { data: startData } = await startInteraction({ flow_kind: 'login' }, sessionCheckRuntime);
    resetAdapter();
    mockSubmitQueries({
      expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
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
    mocks.sessionStore.getSessionRpc.mockResolvedValue({
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
      expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
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

  it("does not record consent for another user's session once the interaction is bound to a user", async () => {
    const { data: startData } = await startInteraction(
      { flow_kind: 'registration', client_id: 'client_1', requested_scope: 'openid profile' },
      consentRuntime
    );
    resetAdapter();
    mockSubmitQueries({
      expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      currentNodeId: 'consent',
      currentStepId: 'consent:step',
      stepState: 'waiting_input',
      runtimeSnapshot: consentRuntime,
      clientId: 'client_1',
      userId: 'user_1',
      context: {
        protocol: 'oidc',
        target_type: 'oidc_client',
        target_id: 'client_1',
        client_id: 'client_1',
        requested_scope: ['openid', 'profile'],
      },
    });
    // A session another tab made for someone else.
    mocks.sessionStore.getSessionRpc.mockResolvedValue({
      userId: 'user_2',
      expiresAt: Date.now() + 60_000,
      createdAt: 1_700_000_000_000,
      data: { authTime: 1_700_000_123 },
    });

    const response = await loginRuntimeInteractionSubmitHandler(
      createContext({
        params: { interaction_id: 'interaction_1' },
        headers: { Cookie: 'authrim_session=sess_runtime_1', 'User-Agent': 'Vitest' },
        body: {
          step_id: 'consent:step',
          node_id: 'consent',
          contract_hash: startData.contract_hash,
          signature: startData.signature,
          input: { consent_item_decisions: { statement_terms: 'granted' } },
        },
      })
    );
    const data = await readJson(response);

    expect(response.status).toBe(403);
    expect(data.error).toBe('access_denied');
    expect(mocks.coreAdapter.execute).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO consent_records'),
      expect.anything()
    );
    expect(mocks.coreAdapter.transaction).not.toHaveBeenCalled();
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
      expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
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
      expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
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

  it('keeps every-time Destination Profile consent visible despite an active matching record', async () => {
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
      expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
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
        identity_mapping: JSON.stringify({ destinationProfileId: 'destination_oidc_1' }),
        attribute_release_consent: JSON.stringify({ enabled: true, mode: 'every_time' }),
      })
      .mockResolvedValueOnce({
        id: 'policy_registration',
        display_name: 'Registration consent policy',
        description: null,
        is_active: 1,
      })
      .mockResolvedValueOnce({ id: 'version_terms_current', version: '20260701' })
      .mockResolvedValueOnce({ id: 'existing_policy_consent_record' })
      .mockResolvedValueOnce({
        id: 'existing_destination_consent_record',
        released_scopes_json: JSON.stringify(['openid', 'profile']),
      });
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
    mocks.adminAdapter.queryOne.mockResolvedValueOnce({
      profile_id: 'destination_oidc_1',
      destination_type: 'oidc',
      version_id: 'destination_oidc_version_1',
      schema_json: JSON.stringify({
        claims: [
          { claimName: 'sub', label: 'Subject', required: true, requiredScopes: ['openid'] },
          { claimName: 'name', label: 'Name', required: false, requiredScopes: ['profile'] },
        ],
      }),
    });
    mocks.sessionStore.getSessionRpc.mockResolvedValueOnce({
      userId: 'user_1',
      expiresAt: Date.now() + 60_000,
      createdAt: 1_700_000_000_000,
      data: { authTime: 1_700_000_123 },
    });

    const response = await loginRuntimeInteractionSubmitHandler(
      createContext({
        env: { DB_ADMIN: mocks.adminAdapter as never },
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
    expect(data.completed).toBe(false);
    expect(data.step).toMatchObject({
      id: 'consent:step',
      content: {
        consent_policy: { items: [] },
        destination_field_consent: {
          profile_id: 'destination_oidc_1',
          profile_version_id: 'destination_oidc_version_1',
          consent_mode: 'every_time',
        },
      },
    });
  });

  it('rejects an unknown selected edge handle instead of falling back to the default branch', async () => {
    const { data: startData } = await startInteraction();
    resetAdapter();
    mockSubmitQueries({
      expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
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
      expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      currentNodeId: 'complete',
      currentStepId: 'complete:step',
      stepState: 'waiting_input',
      runtimeSnapshot: oidcCompletionRuntime,
      editorSnapshot: null,
    });

    mocks.sessionStore.getSessionRpc.mockResolvedValue({
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
      expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
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
      'https://first.test.authrim.com',
      // The session's recorded method (its amr) and proof time; this fixture records neither.
      undefined,
      undefined
    );
  });

  it("refuses to continue with a session that is not the interaction user's", async () => {
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
      expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
      contractHash: String(startData.contract_hash),
      signature: String(startData.signature),
      currentNodeId: 'complete',
      currentStepId: 'complete:step',
      stepState: 'waiting_input',
      runtimeSnapshot: oidcCompletionRuntime,
      editorSnapshot: null,
      userId: 'user_1',
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
    mocks.sessionStore.getSessionRpc.mockResolvedValueOnce({
      userId: 'user_2',
      expiresAt: Date.now() + 60_000,
      createdAt: 1_700_000_000_000,
      data: { authTime: 1_700_000_123 },
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
    expect(response.status).toBe(403);
    expect(mocks.consumeAuthorizationChallengeContinuation).not.toHaveBeenCalled();
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
      expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
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

  describe('a completion waits for someone who is signed in', () => {
    const session = {
      userId: 'user_1',
      expiresAt: Date.now() + 60_000,
      createdAt: 1_700_000_000_000,
      data: { amr: ['email_code'], authTime: 1_700_000_300, proven_at: 1_700_000_300_000 },
    };
    const consentSelectorRuntime: FlowRuntimeContract = {
      flow_kind: 'login',
      ui: {
        steps: [
          {
            id: 'auth:step',
            source_node_id: 'auth',
            component: 'authentication_method_selector',
            render: true,
            config: { consent_policy_ref: 'policy_login' },
          },
          oidcAuthCompletionRuntime.ui.steps[1],
        ],
      },
    };

    async function submitStep(options: {
      runtime: FlowRuntimeContract;
      editor?: Record<string, unknown> | null;
      flowKind?: string;
      currentStep: { node: string; step: string };
      handle: string;
      withSession?: boolean;
      body?: Record<string, unknown>;
      context?: Record<string, unknown>;
      userId?: string;
      authorizationChallengeId?: string;
      /** Mocks for what the step reads, set after the interaction's own rows are mocked. */
      beforeSubmit?: () => void;
      sessionCreatedAt?: number;
      startedAtMs?: number;
    }) {
      // A step may be submitted more than once in a test; each starts from a clean state.
      resetAdapter();
      const { data: startData } = await startInteraction(
        {
          flow_kind: options.flowKind ?? 'login',
          client_id: 'client_1',
          requested_scope: 'openid profile',
          ...(options.authorizationChallengeId
            ? { authorization_challenge_id: options.authorizationChallengeId }
            : {}),
        },
        options.runtime,
        options.editor ?? null
      );
      resetAdapter();
      mockSubmitQueries({
        expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
        contractHash: String(startData.contract_hash),
        signature: String(startData.signature),
        currentNodeId: options.currentStep.node,
        currentStepId: options.currentStep.step,
        stepState: 'waiting_input',
        runtimeSnapshot: options.runtime,
        editorSnapshot: options.editor ?? null,
        clientId: 'client_1',
        userId: options.userId,
        context: {
          target_type: 'oidc_client',
          target_id: 'client_1',
          client_id: 'client_1',
          started_at_ms: options.startedAtMs ?? Date.now() - 1000,
          ...(options.authorizationChallengeId
            ? { authorization_challenge_id: options.authorizationChallengeId }
            : {}),
          ...options.context,
        },
      });
      options.beforeSubmit?.();
      mocks.sessionStore.getSessionRpc.mockResolvedValue(
        options.withSession
          ? { ...session, createdAt: options.sessionCreatedAt ?? session.createdAt }
          : null
      );
      if (!mocks.consumeAuthorizationChallengeContinuation.getMockImplementation()) {
        mocks.consumeAuthorizationChallengeContinuation.mockResolvedValue({
          type: 'login',
          redirectUrl: 'https://first.test.authrim.com/authorize?_confirmation_challenge=confirm_1',
        });
      }
      const response = await loginRuntimeInteractionSubmitHandler(
        createContext({
          params: { interaction_id: 'interaction_1' },
          headers: options.withSession ? { Cookie: 'authrim_session=sess_runtime_1' } : {},
          url: 'https://first.test.authrim.com/api/v1/login/interactions/interaction_1/submit',
          body: {
            step_id: options.currentStep.step,
            node_id: options.currentStep.node,
            selected_handle: options.handle,
            contract_hash: startData.contract_hash,
            signature: startData.signature,
            ...options.body,
          },
        })
      );
      return { response, data: await readJson(response) };
    }

    function interactionUserWasSet() {
      return mocks.coreAdapter.execute.mock.calls.some(
        ([sql]) => typeof sql === 'string' && sql.includes('SET user_id = COALESCE(user_id')
      );
    }

    /** What the interaction's transaction ran, as [sql, params]. */
    const transactionStatements = () => txExecuteCalls;

    const expectNothingWritten = () => {
      expect(mocks.coreAdapter.transaction).not.toHaveBeenCalled();
      expect(mocks.consumeAuthorizationChallengeContinuation).not.toHaveBeenCalled();
      expect(
        mocks.coreAdapter.execute.mock.calls.filter(([sql]) =>
          String(sql).includes('user_id IS NULL')
        )
      ).toEqual([]);
    };

    const auditEventTypes = () =>
      mocks.coreAdapter.execute.mock.calls
        .filter(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO flow_audit_events'))
        .map(([, params]) => (params as unknown[])[10]);

    it.each([
      [
        'a login Flow',
        'login',
        oidcAuthCompletionRuntime,
        null,
        { node: 'auth', step: 'auth:step' },
        'mail_otp',
      ],
      [
        'a registration Flow (the account action is skipped)',
        'registration',
        implicitAccountActionRuntime,
        implicitAccountActionEditor,
        { node: 'auth', step: 'auth:step' },
        'passkey',
      ],
    ])(
      'keeps %s at its completion after a method is chosen before anyone is signed in',
      async (_label, flowKind, runtime, editor, currentStep, handle) => {
        const { response, data } = await submitStep({
          runtime,
          editor,
          flowKind,
          currentStep,
          handle,
        });

        expect(response.status).toBe(200);
        expect(data.completed).toBe(false);
        expect(data.interaction).toMatchObject({
          state: 'active',
          current_step_id: 'complete:step',
        });
        expect(data.step).toMatchObject({ id: 'complete:step', component: 'completion' });
        expect(data.output).toBeNull();
        expect(mocks.consumeAuthorizationChallengeContinuation).not.toHaveBeenCalled();
        // The interaction is not recorded as complete before anyone has signed in.
        expect(auditEventTypes()).toEqual(
          expect.arrayContaining(['flow.auth_method.selected', 'flow.node.entered'])
        );
        expect(auditEventTypes()).not.toContain('flow.interaction.completed');
        expect(auditEventTypes()).not.toContain('flow.output.completed');
      }
    );

    it('answers a completion submitted with no session with a sign-in request and records nothing', async () => {
      const { response, data } = await submitStep({
        runtime: oidcAuthCompletionRuntime,
        currentStep: { node: 'complete', step: 'complete:step' },
        handle: 'completed',
        withSession: false,
      });

      expect(response.status).toBe(401);
      expect(data).toMatchObject({
        error: 'authentication_required',
        category: 'reauthentication_required',
        action: 'reauthenticate',
      });
      expect(mocks.coreAdapter.transaction).not.toHaveBeenCalled();
      expect(mocks.consumeAuthorizationChallengeContinuation).not.toHaveBeenCalled();
      expect(auditEventTypes()).toEqual([]);
    });

    it('does not complete a Flow for the protocol-less /login either', async () => {
      const { response } = await submitStep({
        runtime: oidcAuthCompletionRuntime,
        currentStep: { node: 'complete', step: 'complete:step' },
        handle: 'completed',
        context: { protocol: 'direct', target_type: 'tenant', target_id: null, client_id: null },
      });

      expect(response.status).toBe(401);
    });

    it('completes with the continuation once the sign-in has given a session', async () => {
      const { response, data } = await submitStep({
        runtime: oidcAuthCompletionRuntime,
        currentStep: { node: 'complete', step: 'complete:step' },
        handle: 'completed',
        withSession: true,
        authorizationChallengeId: 'login_challenge_1',
      });

      expect(response.status).toBe(200);
      expect(data.completed).toBe(true);
      expect(data.output).toMatchObject({
        action: 'continue_protocol',
        redirect_url: 'https://first.test.authrim.com/authorize?_confirmation_challenge=confirm_1',
      });
      expect(auditEventTypes()).toContain('flow.interaction.completed');
    });

    it('completes a /login without an authorization request for a signed-in browser', async () => {
      const { response, data } = await submitStep({
        runtime: oidcAuthCompletionRuntime,
        currentStep: { node: 'complete', step: 'complete:step' },
        handle: 'completed',
        withSession: true,
        context: { protocol: 'direct', target_type: 'tenant', target_id: null, client_id: null },
      });

      expect(response.status).toBe(200);
      expect(data.completed).toBe(true);
      expect(data.output).toMatchObject({ action: 'complete' });
    });

    it('does not let a session from before a registration began answer it', async () => {
      // The browser holds a session from long ago (another account's, or the same one's): a new
      // registration is not completed by it.
      const { response, data } = await submitStep({
        runtime: implicitAccountActionRuntime,
        editor: implicitAccountActionEditor,
        flowKind: 'registration',
        currentStep: { node: 'auth', step: 'auth:step' },
        handle: 'passkey',
        withSession: true,
      });

      expect(response.status).toBe(200);
      expect(data.completed).toBe(false);
      expect(data.step).toMatchObject({ component: 'completion' });
      expect(mocks.consumeAuthorizationChallengeContinuation).not.toHaveBeenCalled();
    });

    it.each([
      ['within the second the registration began, but before it', 1_700_000_000_100, false],
      ['at the moment it began', 1_700_000_000_900, true],
      ['after it began', 1_700_000_000_950, true],
    ])('judges a session made %s to the millisecond', async (_label, createdAt, answers) => {
      const { data } = await submitStep({
        runtime: implicitAccountActionRuntime,
        editor: implicitAccountActionEditor,
        flowKind: 'registration',
        currentStep: { node: 'auth', step: 'auth:step' },
        handle: 'passkey',
        withSession: true,
        startedAtMs: 1_700_000_000_900,
        sessionCreatedAt: createdAt,
      });

      expect(data.completed).toBe(answers);
    });

    it('lets a session made since the registration began answer it', async () => {
      const { response, data } = await submitStep({
        runtime: implicitAccountActionRuntime,
        editor: implicitAccountActionEditor,
        flowKind: 'registration',
        currentStep: { node: 'auth', step: 'auth:step' },
        handle: 'passkey',
        withSession: true,
        sessionCreatedAt: Date.now() + 1000,
      });

      expect(response.status).toBe(200);
      expect(data.completed).toBe(true);
    });

    it('answers a challenge that is gone and left no confirmation with an expired request, not a sign-in request', async () => {
      const { response, data } = await submitStep({
        runtime: oidcAuthCompletionRuntime,
        currentStep: { node: 'complete', step: 'complete:step' },
        handle: 'completed',
        withSession: true,
        authorizationChallengeId: 'login_challenge_1',
        beforeSubmit: () =>
          mocks.readAuthorizationChallengeFreshness.mockResolvedValue({
            kind: 'login',
            issuedAt: Infinity,
            gone: true,
          }),
      });

      expect(response.status).toBe(400);
      expect(data).toMatchObject({
        error: 'authorization_request_expired',
        action: 'restart_interaction',
      });
      expectNothingWritten();
    });

    it('lets no session answer a challenge that was continued for another user, and writes nothing', async () => {
      const { response, data } = await submitStep({
        runtime: oidcAuthCompletionRuntime,
        currentStep: { node: 'complete', step: 'complete:step' },
        handle: 'completed',
        withSession: true,
        authorizationChallengeId: 'login_challenge_1',
        beforeSubmit: () =>
          mocks.readAuthorizationChallengeFreshness.mockResolvedValue({
            kind: 'login',
            issuedAt: 0,
            confirmedFor: 'user_2',
          }),
      });

      expect(response.status).toBe(401);
      expect(data.error).toBe('authentication_required');
      expectNothingWritten();
    });

    it('ends a session check on a challenge that is gone, instead of signing in', async () => {
      const { data: startData } = await startInteraction(
        { flow_kind: 'login' },
        sessionCheckRuntime
      );
      resetAdapter();
      mockSubmitQueries({
        expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
        contractHash: String(startData.contract_hash),
        signature: String(startData.signature),
        currentNodeId: 'session-check',
        currentStepId: 'session-check:step',
        stepState: 'pending',
        runtimeSnapshot: sessionCheckRuntime,
        editorSnapshot: sessionCheckEditor,
        context: { authorization_challenge_id: 'login_challenge_1' },
      });
      mocks.readAuthorizationChallengeFreshness.mockResolvedValue({
        kind: 'login',
        issuedAt: Infinity,
        gone: true,
      });
      mocks.sessionStore.getSessionRpc.mockResolvedValue({
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

      expect(data.error).toBe('authorization_request_expired');
      expect(data.step ?? null).toBeNull();
    });

    it("does not let another user's session answer a re-authentication, whatever is held", async () => {
      const { response, data } = await submitStep({
        runtime: oidcAuthCompletionRuntime,
        currentStep: { node: 'complete', step: 'complete:step' },
        handle: 'completed',
        withSession: true,
        authorizationChallengeId: 'reauth_challenge_1',
        beforeSubmit: () =>
          mocks.readAuthorizationChallengeFreshness.mockResolvedValue({
            kind: 'reauth',
            issuedAt: 1_700_000_000_000,
            subjectUserId: 'user_2',
          }),
      });

      expect(response.status).toBe(401);
      expect(data.error).toBe('authentication_required');
      expect(mocks.coreAdapter.transaction).not.toHaveBeenCalled();
      expect(mocks.consumeAuthorizationChallengeContinuation).not.toHaveBeenCalled();
      expect(auditEventTypes()).toEqual([]);
    });

    it('does not complete the interaction when the authorization request cannot be continued', async () => {
      const { response, data } = await submitStep({
        runtime: oidcAuthCompletionRuntime,
        currentStep: { node: 'complete', step: 'complete:step' },
        handle: 'completed',
        withSession: true,
        authorizationChallengeId: 'login_challenge_1',
        beforeSubmit: () =>
          mocks.consumeAuthorizationChallengeContinuation.mockResolvedValue({
            error: new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            }),
          }),
      });

      expect(response.status).toBe(503);
      expect(data.error).toBe('temporarily_unavailable');
      // Nothing is saved as complete or audited as a success: the browser can submit again.
      expect(mocks.coreAdapter.transaction).not.toHaveBeenCalled();
      expect(auditEventTypes()).toEqual([]);
    });

    describe('consent given at the method selection', () => {
      const policyRow = {
        id: 'policy_login',
        display_name: 'Login consent',
        description: null,
        is_active: 1,
      };
      const itemRow = {
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
        conditional_rules_json: null,
      };

      /**
       * What the consent tables hold, for whatever the step reads after the interaction's own rows
       * (those come first, from the queue mockSubmitQueries fills). `queryOne` and `query` may
       * answer other statements first.
       */
      function withPolicy(
        extra: {
          queryOne?: (sql: string) => unknown;
          query?: (sql: string) => unknown[] | undefined;
        } = {}
      ) {
        mocks.coreAdapter.queryOne.mockImplementation(async (sql: string) => {
          const answered = extra.queryOne?.(sql);
          if (answered !== undefined) return answered;
          if (sql.includes('FROM consent_policies')) return policyRow;
          if (sql.includes('FROM consent_statement_versions')) {
            return { id: 'version_terms_current', version: '20260701' };
          }
          return null;
        });
        mocks.coreAdapter.query.mockImplementation(async (sql: string) => {
          const answered = extra.query?.(sql);
          if (answered !== undefined) return answered;
          if (sql.includes('FROM consent_policy_items')) return [itemRow];
          if (sql.includes('FROM consent_statement_localizations')) {
            return [
              {
                language: 'en',
                title: 'Terms',
                description: '',
                document_url: 'https://example.com/tos',
                inline_content: null,
              },
            ];
          }
          return [];
        });
      }

      const consentRecords = () =>
        mocks.coreAdapter.execute.mock.calls.filter(
          ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO consent_records')
        );

      const given = { input: { consent_item_decisions: { statement_terms: 'granted' } } };

      it('refuses a selection that leaves a required consent ungiven, with nobody signed in', async () => {
        const { response, data } = await submitStep({
          runtime: consentSelectorRuntime,
          currentStep: { node: 'auth', step: 'auth:step' },
          handle: 'mail_otp',
          beforeSubmit: withPolicy,
        });

        expect(response.status).toBe(400);
        expect(data.error).toBe('consent_required');
        expect(mocks.coreAdapter.transaction).not.toHaveBeenCalled();
      });

      it('keeps what was given until someone is signed in, recording nothing for anyone yet', async () => {
        const { response, data } = await submitStep({
          runtime: consentSelectorRuntime,
          currentStep: { node: 'auth', step: 'auth:step' },
          handle: 'mail_otp',
          body: given,
          beforeSubmit: withPolicy,
        });

        expect(response.status).toBe(200);
        expect(data.step).toMatchObject({ component: 'completion' });
        expect(consentRecords()).toEqual([]);
        expect(interactionUserWasSet()).toBe(false);
        // The step is stored with the consent that was given.
        const stepUpdates = transactionStatements().filter(([sql]) =>
          String(sql).includes('UPDATE flow_interaction_steps')
        );
        expect(JSON.stringify(stepUpdates)).toContain('held_consent');
        expect(JSON.stringify(stepUpdates)).toContain('statement_terms');
      });

      /** The consent a selection kept, as the step's stored state. */
      async function keptBySelection() {
        await submitStep({
          runtime: consentSelectorRuntime,
          currentStep: { node: 'auth', step: 'auth:step' },
          handle: 'mail_otp',
          body: given,
          beforeSubmit: withPolicy,
        });
        const update = transactionStatements().find(([sql]) =>
          String(sql).includes('UPDATE flow_interaction_steps')
        );
        return String((update?.[1] as unknown[])[1]);
      }

      function readsKept(stateJson: string, extra: { queryOne?: (sql: string) => unknown } = {}) {
        withPolicy({
          ...extra,
          query: (sql) =>
            sql.includes('held_consent')
              ? [{ id: 'step_1', step_id: 'auth:step', state_json: stateJson }]
              : undefined,
        });
      }

      it('records it for the user who signs in, when the completion is submitted', async () => {
        const stateJson = await keptBySelection();
        const { response, data } = await submitStep({
          runtime: consentSelectorRuntime,
          currentStep: { node: 'complete', step: 'complete:step' },
          handle: 'completed',
          withSession: true,
          authorizationChallengeId: 'login_challenge_1',
          beforeSubmit: () => readsKept(stateJson),
        });

        expect(response.status, JSON.stringify(data)).toBe(200);
        expect(data.completed).toBe(true);
        expect(consentRecords()).toHaveLength(1);
        expect(consentRecords()[0][1]).toEqual(expect.arrayContaining(['tenant_test', 'user_1']));
        // The record has a fixed identifier, so a retry or a concurrent attempt cannot add another.
        expect(consentRecords()[0][0]).toContain('ON CONFLICT(id) DO UPDATE');
        expect(String((consentRecords()[0][1] as unknown[])[0])).toMatch(/^consent_[0-9a-f]{64}$/);
        // Each is recorded once.
        expect(
          mocks.coreAdapter.execute.mock.calls.filter(
            ([sql, params]) =>
              String(sql).includes('UPDATE flow_interaction_steps') &&
              JSON.stringify(params).includes('held_consent_recorded')
          )
        ).toHaveLength(1);
      });

      it('records it in the version it was given for, and asks again when that version changed', async () => {
        const stateJson = await keptBySelection();
        expect(stateJson).toContain('20260701');

        const { response, data } = await submitStep({
          runtime: consentSelectorRuntime,
          currentStep: { node: 'complete', step: 'complete:step' },
          handle: 'completed',
          withSession: true,
          authorizationChallengeId: 'login_challenge_1',
          beforeSubmit: () =>
            // The statement has a newer version by now.
            readsKept(stateJson, {
              queryOne: (sql) =>
                sql.includes('FROM consent_statement_versions')
                  ? { id: 'version_terms_next', version: '20260901' }
                  : undefined,
            }),
        });

        expect(response.status).toBe(400);
        expect(data.error).toBe('consent_changed');
        expect(consentRecords()).toEqual([]);
        expect(mocks.consumeAuthorizationChallengeContinuation).not.toHaveBeenCalled();
        // The interaction goes back to the step that took the consent, nothing held, and is not
        // completed.
        const statements = transactionStatements().map(([sql]) => String(sql));
        expect(statements.some((sql) => sql.includes("state = 'waiting_input'"))).toBe(true);
        expect(statements.some((sql) => sql.includes("state = 'completed'"))).toBe(false);
      });

      it('judges the conditions again when what was held is already recorded', async () => {
        const stateJson = await keptBySelection();
        const { response, data } = await submitStep({
          runtime: consentSelectorRuntime,
          currentStep: { node: 'complete', step: 'complete:step' },
          handle: 'completed',
          withSession: true,
          authorizationChallengeId: 'login_challenge_1',
          beforeSubmit: () =>
            // Recorded, and the statement has a newer version since.
            readsKept(JSON.stringify({ ...JSON.parse(stateJson), held_consent_recorded: true }), {
              queryOne: (sql) =>
                sql.includes('FROM consent_statement_versions')
                  ? { id: 'version_terms_next', version: '20260901' }
                  : undefined,
            }),
        });

        expect(response.status).toBe(400);
        expect(data.error).toBe('consent_changed');
        expect(mocks.consumeAuthorizationChallengeContinuation).not.toHaveBeenCalled();
      });

      it('is not recorded for a user when another has already been given the interaction', async () => {
        const stateJson = await keptBySelection();
        const { response, data } = await submitStep({
          runtime: consentSelectorRuntime,
          currentStep: { node: 'complete', step: 'complete:step' },
          handle: 'completed',
          withSession: true,
          beforeSubmit: () => {
            // Another session claimed the interaction first.
            readsKept(stateJson, {
              queryOne: (sql) =>
                sql.includes('SELECT user_id FROM flow_interactions')
                  ? { user_id: 'user_2' }
                  : undefined,
            });
            mocks.coreAdapter.execute.mockImplementation(async (sql: string) => ({
              success: true,
              rowsAffected: String(sql).includes('user_id IS NULL') ? 0 : 1,
            }));
          },
        });

        expect(response.status, JSON.stringify(data)).toBe(403);
        expect(consentRecords()).toEqual([]);
        expect(mocks.coreAdapter.transaction).not.toHaveBeenCalled();
      });

      it('still asks whom the interaction is about when what was held is already recorded', async () => {
        const stateJson = await keptBySelection();
        const { response } = await submitStep({
          runtime: consentSelectorRuntime,
          currentStep: { node: 'complete', step: 'complete:step' },
          handle: 'completed',
          withSession: true,
          authorizationChallengeId: 'login_challenge_1',
          beforeSubmit: () => {
            // Another session was given the interaction and recorded the consent; this one read the
            // interaction before that, and finds the consent already recorded.
            readsKept(JSON.stringify({ ...JSON.parse(stateJson), held_consent_recorded: true }), {
              queryOne: (sql) =>
                sql.includes('SELECT user_id FROM flow_interactions')
                  ? { user_id: 'user_2' }
                  : undefined,
            });
            mocks.coreAdapter.execute.mockImplementation(async (sql: string) => ({
              success: true,
              rowsAffected: String(sql).includes('user_id IS NULL') ? 0 : 1,
            }));
          },
        });

        expect(response.status).toBe(403);
        expect(mocks.consumeAuthorizationChallengeContinuation).not.toHaveBeenCalled();
        expect(mocks.coreAdapter.transaction).not.toHaveBeenCalled();
      });

      it('is recorded when the Flow ends at a step after the completion was reached', async () => {
        // A screen follows the selection; the completion is reached from the screen's own submit.
        const screenRuntime: FlowRuntimeContract = {
          flow_kind: 'login',
          ui: {
            steps: [
              consentSelectorRuntime.ui.steps[0],
              { id: 'screen:step', source_node_id: 'screen', component: 'screen', render: true },
              consentSelectorRuntime.ui.steps[1],
            ],
          },
        };
        const stateJson = await keptBySelection();
        const { response, data } = await submitStep({
          runtime: screenRuntime,
          currentStep: { node: 'screen', step: 'screen:step' },
          handle: 'submitted',
          withSession: true,
          authorizationChallengeId: 'login_challenge_1',
          beforeSubmit: () => readsKept(stateJson),
        });

        expect(response.status).toBe(200);
        expect(data.completed).toBe(true);
        expect(consentRecords()).toHaveLength(1);
        // Recorded before the continuation, so the continuation is not the first of the two to run.
        expect(mocks.consumeAuthorizationChallengeContinuation).toHaveBeenCalledTimes(1);
      });

      it('does not record it again once recorded', async () => {
        const stateJson = await keptBySelection();
        const { response } = await submitStep({
          runtime: consentSelectorRuntime,
          currentStep: { node: 'complete', step: 'complete:step' },
          handle: 'completed',
          withSession: true,
          beforeSubmit: () =>
            readsKept(JSON.stringify({ ...JSON.parse(stateJson), held_consent_recorded: true })),
        });

        expect(response.status).toBe(200);
        expect(consentRecords()).toEqual([]);
      });
    });

    it('keeps a spent challenge as it is when only a selection is made', async () => {
      const { response } = await submitStep({
        runtime: oidcAuthCompletionRuntime,
        currentStep: { node: 'auth', step: 'auth:step' },
        handle: 'mail_otp',
        authorizationChallengeId: 'login_challenge_1',
      });

      expect(response.status).toBe(200);
      expect(mocks.consumeAuthorizationChallengeContinuation).not.toHaveBeenCalled();
    });
  });

  describe('a session the authorization challenge would refuse as proof', () => {
    // A sign-in for a client whose SSO is off (login) and a re-authentication (reauth) are
    // answered only by a proof made after the challenge. The browser's older session is then not
    // used at all, so the user can sign in by a method of their own instead of being stopped.
    const challengeIssuedAt = 1_700_000_200_000;
    const staleSession = {
      userId: 'user_1',
      expiresAt: Date.now() + 60_000,
      createdAt: 1_700_000_000_000,
      data: { amr: ['passkey'], authTime: 1_700_000_123, proven_at: 1_700_000_123_000 },
    };
    const freshSession = {
      ...staleSession,
      data: { amr: ['passkey'], authTime: 1_700_000_300, proven_at: 1_700_000_300_000 },
    };

    async function submitMailOtpSelection(freshness: unknown, session: unknown, readError?: Error) {
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
        expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
        contractHash: String(startData.contract_hash),
        signature: String(startData.signature),
        currentNodeId: 'auth',
        currentStepId: 'auth:step',
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
      if (readError) {
        mocks.readAuthorizationChallengeFreshness.mockRejectedValue(readError);
      } else {
        mocks.readAuthorizationChallengeFreshness.mockResolvedValue(freshness);
      }
      mocks.sessionStore.getSessionRpc.mockResolvedValue(session);
      mocks.consumeAuthorizationChallengeContinuation.mockResolvedValue({
        type: 'login',
        redirectUrl: 'https://first.test.authrim.com/authorize?_confirmation_challenge=confirm_1',
      });

      const response = await loginRuntimeInteractionSubmitHandler(
        createContext({
          params: { interaction_id: 'interaction_1' },
          headers: { Cookie: 'authrim_session=sess_runtime_1' },
          url: 'https://first.test.authrim.com/api/v1/login/interactions/interaction_1/submit',
          body: {
            step_id: 'auth:step',
            node_id: 'auth',
            selected_handle: 'mail_otp',
            contract_hash: startData.contract_hash,
            signature: startData.signature,
          },
        })
      );
      return { response, data: await readJson(response) };
    }

    function interactionUserWasSet() {
      return mocks.coreAdapter.execute.mock.calls.some(
        ([sql]) => typeof sql === 'string' && sql.includes('SET user_id = COALESCE(user_id')
      );
    }

    it.each([
      ['a sign-in for a client whose SSO is off', 'login'],
      ['a re-authentication', 'reauth'],
    ] as const)(
      'selects a sign-in method without using an older session for %s',
      async (_label, kind) => {
        const { response, data } = await submitMailOtpSelection(
          { kind, issuedAt: challengeIssuedAt },
          staleSession
        );

        expect(response.status).toBe(200);
        expect(mocks.consumeAuthorizationChallengeContinuation).not.toHaveBeenCalled();
        expect(interactionUserWasSet()).toBe(false);
        // Not complete: the completion waits for the sign-in the selected method will give.
        expect(data.completed).toBe(false);
        expect(data.step).toMatchObject({ id: 'complete:step', component: 'completion' });
        expect(data.output).toBeNull();
      }
    );

    it('does not attribute consent given at the selector to an older session the challenge refuses', async () => {
      const consentSelectorRuntime: FlowRuntimeContract = {
        flow_kind: 'login',
        ui: {
          steps: [
            {
              id: 'auth:step',
              source_node_id: 'auth',
              component: 'authentication_method_selector',
              render: true,
              config: { consent_policy_ref: 'policy_login' },
            },
            oidcAuthCompletionRuntime.ui.steps[1],
          ],
        },
      };
      const { data: startData } = await startInteraction(
        {
          flow_kind: 'login',
          client_id: 'client_1',
          requested_scope: 'openid profile',
          authorization_challenge_id: 'login_challenge_1',
        },
        consentSelectorRuntime
      );
      resetAdapter();
      mockSubmitQueries({
        expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
        contractHash: String(startData.contract_hash),
        signature: String(startData.signature),
        currentNodeId: 'auth',
        currentStepId: 'auth:step',
        stepState: 'waiting_input',
        runtimeSnapshot: consentSelectorRuntime,
        editorSnapshot: null,
        context: {
          target_type: 'oidc_client',
          target_id: 'client_1',
          client_id: 'client_1',
          authorization_challenge_id: 'login_challenge_1',
        },
      });
      // The consent policy exists and has no item to record: only the user it is attributed to
      // is in question.
      const readRows = mocks.coreAdapter.queryOne.getMockImplementation();
      mocks.coreAdapter.queryOne.mockImplementation(async (sql: string, ...rest: unknown[]) =>
        sql.includes('FROM consent_policies')
          ? { id: 'policy_login', display_name: 'Login consent', description: null, is_active: 1 }
          : readRows?.(sql, ...rest)
      );
      mocks.readAuthorizationChallengeFreshness.mockResolvedValue({
        kind: 'login',
        issuedAt: challengeIssuedAt,
      });
      mocks.sessionStore.getSessionRpc.mockResolvedValue(staleSession);

      const response = await loginRuntimeInteractionSubmitHandler(
        createContext({
          params: { interaction_id: 'interaction_1' },
          headers: { Cookie: 'authrim_session=sess_runtime_1' },
          url: 'https://first.test.authrim.com/api/v1/login/interactions/interaction_1/submit',
          body: {
            step_id: 'auth:step',
            node_id: 'auth',
            selected_handle: 'mail_otp',
            contract_hash: startData.contract_hash,
            signature: startData.signature,
          },
        })
      );

      expect(response.status).toBe(200);
      expect(interactionUserWasSet()).toBe(false);
      expect(mocks.consumeAuthorizationChallengeContinuation).not.toHaveBeenCalled();
    });

    it('asks to try again, recording nothing, when the challenge cannot be read', async () => {
      // Neither "no session" (the user would be sent on unauthenticated) nor "this session" (it
      // could not be judged): the interaction stays open for the browser to submit again.
      const { response, data } = await submitMailOtpSelection(
        null,
        freshSession,
        new Error('challenge store unavailable')
      );

      expect(response.status).toBe(503);
      expect(data).toMatchObject({ error: 'temporarily_unavailable', action: 'retry_step' });
      expect(mocks.consumeAuthorizationChallengeContinuation).not.toHaveBeenCalled();
      expect(mocks.coreAdapter.transaction).not.toHaveBeenCalled();
    });

    it('does not use a re-authentication session that records no method', async () => {
      const { response } = await submitMailOtpSelection(
        { kind: 'reauth', issuedAt: challengeIssuedAt },
        { ...freshSession, data: { authTime: 1_700_000_300, proven_at: 1_700_000_300_000 } }
      );

      expect(response.status).toBe(200);
      expect(mocks.consumeAuthorizationChallengeContinuation).not.toHaveBeenCalled();
    });

    it.each(['login', 'reauth'] as const)(
      'still continues with a session proven after the %s challenge',
      async (kind) => {
        const { response, data } = await submitMailOtpSelection(
          { kind, issuedAt: challengeIssuedAt },
          freshSession
        );

        expect(response.status).toBe(200);
        expect(mocks.consumeAuthorizationChallengeContinuation).toHaveBeenCalledTimes(1);
        expect(data.output).toMatchObject({
          redirect_url:
            'https://first.test.authrim.com/authorize?_confirmation_challenge=confirm_1',
        });
      }
    );

    it('continues with any session when the challenge asks for no newer proof', async () => {
      const { response, data } = await submitMailOtpSelection(null, staleSession);

      expect(response.status).toBe(200);
      expect(mocks.consumeAuthorizationChallengeContinuation).toHaveBeenCalledTimes(1);
      expect(data.output).toHaveProperty('redirect_url');
    });
  });

  it('rejects submit when the runtime signature does not match the active interaction', async () => {
    const { data: startData } = await startInteraction();
    resetAdapter();
    mockSubmitQueries({
      expiresAt: Number((startData.interaction as Record<string, unknown>).expires_at),
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
