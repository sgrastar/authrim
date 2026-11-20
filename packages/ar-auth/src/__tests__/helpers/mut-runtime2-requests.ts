/**
 * Requests to the LoginUI runtime Flow handlers over the fakes of mut-runtime2-mocks.ts (copied
 * from login-runtime-flow.test.ts): a context, the interaction rows a start or a submit reads.
 */
import { vi } from 'vitest';
import type { Context } from 'hono';
import type { DatabaseAdapter, Env, FlowRuntimeContract } from '@authrim/ar-lib-core';
import { libCore, mocks } from './mut-runtime2-mocks';

export type RuntimeContext = Context<{ Bindings: Env }>;

export const runtime: FlowRuntimeContract = {
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

export function createContext(input: {
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

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const data: unknown = await response.json();
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

/** The statements run in the interaction's batches since the last reset. */
export const txExecuteCalls: Array<[string, unknown[] | undefined]> = [];

/**
 * The selection and reading of the Mapping Set the app is bound to (tested in ar-lib-core): an app
 * that names a Mapping Set is bound to it, with `destination_oidc_1` as its Destination Profile,
 * and one that names none is bound to nothing.
 */
function oidcResolution(setId: string | null, destinationProfileId = 'destination_oidc_1') {
  const chain = [
    { tier: 'client', state: setId ? 'set' : 'unset' },
    { tier: 'tenant_default', state: 'unset' },
    { tier: 'platform_default', state: 'unset' },
  ];
  return setId
    ? {
        selection: { kind: 'bound', tier: 'client', setId, chain },
        binding: {
          fieldMappingSetId: setId,
          destinationProfileId,
          destinationProfileIds: [destinationProfileId],
        },
      }
    : { selection: { kind: 'none', reason: 'no_default', chain }, binding: null };
}

/** The selection's reading of the app's own choice is the real one. */
export function failIfNotAChoice(clientSelector: unknown): void {
  if (!libCore) throw new Error('mockLibCore has not run');
  const choice = libCore.readClientIdentityMappingChoice(clientSelector);
  if (choice.kind === 'invalid') {
    throw new libCore.IdentityMappingSelectionError(
      'client_selector_invalid',
      'client',
      undefined,
      choice.reason
    );
  }
}

export function namedSetId(clientSelector: unknown): string | null {
  try {
    const value = (
      typeof clientSelector === 'string' ? JSON.parse(clientSelector) : (clientSelector ?? {})
    ) as { fieldMappingSetId?: unknown } | null;
    return typeof value?.fieldMappingSetId === 'string' ? value.fieldMappingSetId : null;
  } catch {
    return null;
  }
}

export async function resetAdapter() {
  vi.clearAllMocks();
  mocks.statementFake.reset();
  mocks.resolveOidcIdentityMappingBinding.mockReset();
  mocks.resolveOidcIdentityMappingBinding.mockImplementation(
    async (input: { clientSelector: unknown }) => {
      failIfNotAChoice(input.clientSelector);
      return oidcResolution(namedSetId(input.clientSelector));
    }
  );
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
  mocks.challengeStore.consumeChallengeRpc.mockReset();
  mocks.runtimeUsers.findById.mockReset();
  mocks.runtimeUsers.updateProfileFields.mockReset().mockResolvedValue(true);
  mocks.runtimeUsers.hasProfile.mockReset().mockResolvedValue(true);
  mocks.piiAdapter.execute.mockReset().mockResolvedValue({ rowsAffected: 1 });
  mocks.publishEvent.mockReset().mockResolvedValue({ success: true });
  mocks.resolveCustomClaimRuntimeSourcesFromHono.mockReset().mockResolvedValue({
    schemaDb: mocks.coreAdapter,
    nonPiiDb: mocks.coreAdapter,
    piiDb: mocks.coreAdapter,
  });
  mocks.validateCustomClaimWrite
    .mockReset()
    .mockImplementation(async (input: { submitted: Record<string, unknown> }) => ({
      ok: true,
      schemas: [],
      nonPiiValues: input.submitted,
      piiValues: {},
      nonPiiKeysToDelete: [],
      piiKeysToDelete: [],
    }));
  mocks.persistCustomClaimWrite.mockReset().mockResolvedValue(undefined);
  mocks.resolveAccountDataContextFromHono.mockReset().mockResolvedValue(undefined);
  mocks.consumeAuthorizationChallengeContinuation.mockReset();
  mocks.readAuthorizationChallengeFreshness.mockReset();
  mocks.readAuthorizationChallengeFreshness.mockResolvedValue(null);
  // No account unless a test gives one (a user without an account has no roles).
  mocks.resolveAccountCoreDataContext.mockReset();
  mocks.resolveAccountCoreDataContext.mockRejectedValue(new Error('account_data_route_not_found'));
  mocks.readConditionAttributes.mockReset();
  (await import('../../login-runtime-flow')).clearLoginRuntimeFlowVersionCacheForTests();
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
  // The interaction's writes go in one batch (atomic, one round trip).
  mocks.coreAdapter.batch.mockImplementation(
    async (statements: Array<{ sql: string; params?: unknown[] }>) =>
      statements.map((statement) => {
        txExecuteCalls.push([statement.sql, statement.params]);
        return { success: true, rowsAffected: 1 };
      })
  );
  mocks.coreAdapter.query.mockResolvedValue([]);
  mocks.coreAdapter.execute.mockResolvedValue({ success: true, rowsAffected: 1 });
  mocks.getFeatureFlag.mockImplementation((_key: string, env: Env) => {
    return (
      (env as Env & { ENABLE_LOGIN_RUNTIME_FLOW?: string }).ENABLE_LOGIN_RUNTIME_FLOW === 'true'
    );
  });
}

export function mockStartQueries(
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

export function mockSubmitQueries(input: {
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

export async function startInteraction(
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
  const { loginRuntimeInteractionStartHandler } = await import('../../login-runtime-flow');
  const response = await loginRuntimeInteractionStartHandler(createContext({ body }));
  const data = await readJson(response);
  return { response, data };
}
