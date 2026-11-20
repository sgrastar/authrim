/**
 * Shared harness for the mut-runtime1-* tests of login-runtime-flow.ts (its first part): the mocks
 * of '@authrim/ar-lib-core' and of direct-auth, a Hono-like context and the start/submit queries.
 *
 * A test file mocks the modules with the factories here, e.g.
 *   vi.mock('@authrim/ar-lib-core', async (importOriginal) =>
 *     (await import('./helpers/mut-runtime1-harness')).libCoreMock(await importOriginal()));
 * and imports `mocks` from this module (the same instance the factories use).
 */
import { vi } from 'vitest';
import type { Context } from 'hono';
import type { DatabaseAdapter, Env, FlowRuntimeContract } from '@authrim/ar-lib-core';

const adapter = () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  batch: vi.fn(),
  isHealthy: vi.fn(),
  getType: vi.fn(),
  close: vi.fn(),
});

export const mocks = {
  coreAdapter: adapter(),
  piiAdapter: { execute: vi.fn(async (..._args: unknown[]) => ({ rowsAffected: 1 })) },
  publishEvent: vi.fn(async (..._args: unknown[]) => ({ success: true })),
  sessionStore: { getSessionRpc: vi.fn() },
  challengeStore: {
    getChallengeRpc: vi.fn(),
    storeChallengeRpc: vi.fn(),
    consumeChallengeRpc: vi.fn(),
  },
  getChallengeStoreByChallengeId: vi.fn(),
  runtimeUsers: {
    findById: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
    updateProfileFields: vi.fn(async (..._args: unknown[]): Promise<boolean> => true),
    hasProfile: vi.fn(async (..._args: unknown[]): Promise<boolean> => true),
  },
  idQueue: [] as string[],
  getFeatureFlag: vi.fn(),
  consumeAuthorizationChallengeContinuation: vi.fn(),
  readAuthorizationChallengeFreshness: vi.fn(),
  resolveAccountCoreDataContext: vi.fn(),
  readConditionAttributes: vi.fn(),
  resolveAccountDataContextFromHono: vi.fn(
    async (..._args: unknown[]): Promise<unknown> => undefined
  ),
  resolveSubjectRoles: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
  resolveSubjectOrganizations: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
  resolveStatementRequirements: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
  readStatementConsentDefinition: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  readStatementConsentRecord: vi.fn(async (..._args: unknown[]): Promise<unknown> => null),
  emitLog: vi.fn(async (..._args: unknown[]): Promise<void> => undefined),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

/** The '@authrim/ar-lib-core' mock: the real module with its stores and readers replaced. */
export function libCoreMock(actual: Record<string, unknown>): Record<string, unknown> {
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.coreAdapter })),
    createAccountAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.coreAdapter })),
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: mocks.piiAdapter })),
    resolveAccountDataContextFromHono: mocks.resolveAccountDataContextFromHono,
    resolveStatementRequirements: mocks.resolveStatementRequirements,
    readStatementConsentDefinition: mocks.readStatementConsentDefinition,
    readStatementConsentRecord: mocks.readStatementConsentRecord,
    publishEvent: mocks.publishEvent,
    CanonicalRuntimeUserStore: class {
      findById(...args: unknown[]) {
        return mocks.runtimeUsers.findById(...args);
      }
      updateProfileFields(...args: unknown[]) {
        return mocks.runtimeUsers.updateProfileFields(...args);
      }
      hasProfile(...args: unknown[]) {
        return mocks.runtimeUsers.hasProfile(...args);
      }
    },
    generateId: vi.fn(() => mocks.idQueue.shift() ?? `generated_${mocks.idQueue.length}`),
    getChallengeStoreByChallengeId: mocks.getChallengeStoreByChallengeId,
    getFeatureFlag: mocks.getFeatureFlag,
    getSessionStoreBySessionId: vi.fn(() => ({ stub: mocks.sessionStore })),
    isShardedSessionId: vi.fn((id: string) => id.startsWith('sess_')),
    getLogger: vi.fn(() => ({
      module: vi.fn(() => ({ info: mocks.info, warn: mocks.warn, error: mocks.error })),
    })),
    getTenantIdFromContext: vi.fn(() => 'tenant_test'),
    resolveAccountCoreDataContext: mocks.resolveAccountCoreDataContext,
    resolveSubjectRoles: mocks.resolveSubjectRoles,
    resolveSubjectOrganizations: mocks.resolveSubjectOrganizations,
    flowConditionAttributeReader: vi.fn(
      () => (keys: string[]) => mocks.readConditionAttributes(keys) as Promise<unknown>
    ),
  };
}

/** The log-iceberg emitter mock: the audit rows a handler writes. */
export function icebergMock(actual: Record<string, unknown>): Record<string, unknown> {
  return { ...actual, emitLogIcebergRow: mocks.emitLog };
}

/** The '../direct-auth' mock: the authorization request reads replaced, the proof rules real. */
export function directAuthMock(actual: Record<string, unknown>): Record<string, unknown> {
  return {
    consumeAuthorizationChallengeContinuation: mocks.consumeAuthorizationChallengeContinuation,
    readAuthorizationChallengeFreshness: mocks.readAuthorizationChallengeFreshness,
    isProofOlderThanChallengeRequirement: actual.isProofOlderThanChallengeRequirement,
    reauthProofFromRecord: actual.reauthProofFromRecord,
  };
}

/** Every statement the handlers wrote (batch, transaction or execute), in order. */
export const written: Array<{ sql: string; params: unknown[] }> = [];

export function resetHarness(): void {
  vi.clearAllMocks();
  written.length = 0;
  const db = mocks.coreAdapter;
  for (const fn of Object.values(db)) fn.mockReset();
  mocks.sessionStore.getSessionRpc.mockReset();
  mocks.challengeStore.getChallengeRpc.mockReset();
  mocks.getChallengeStoreByChallengeId.mockReset().mockResolvedValue(mocks.challengeStore);
  mocks.runtimeUsers.findById.mockReset();
  mocks.runtimeUsers.updateProfileFields.mockReset().mockResolvedValue(true);
  mocks.runtimeUsers.hasProfile.mockReset().mockResolvedValue(true);
  mocks.publishEvent.mockReset().mockResolvedValue({ success: true });
  mocks.emitLog.mockReset().mockResolvedValue(undefined);
  mocks.consumeAuthorizationChallengeContinuation.mockReset();
  mocks.readAuthorizationChallengeFreshness.mockReset().mockResolvedValue(null);
  mocks.resolveAccountCoreDataContext
    .mockReset()
    .mockRejectedValue(new Error('account_data_route_not_found'));
  mocks.readConditionAttributes.mockReset();
  mocks.resolveAccountDataContextFromHono.mockReset().mockResolvedValue(undefined);
  mocks.resolveSubjectRoles.mockReset().mockResolvedValue([]);
  mocks.resolveSubjectOrganizations.mockReset().mockResolvedValue([]);
  mocks.resolveStatementRequirements.mockReset().mockResolvedValue([]);
  mocks.readStatementConsentDefinition.mockReset().mockResolvedValue(null);
  mocks.readStatementConsentRecord.mockReset().mockResolvedValue(null);
  mocks.idQueue.splice(0, mocks.idQueue.length, 'interaction_1', 'step_1', 'audit_1', 'audit_2');
  db.getType.mockReturnValue('mock');
  db.query.mockResolvedValue([]);
  db.execute.mockImplementation(async (sql: string, params?: unknown[]) => {
    written.push({ sql, params: params ?? [] });
    return { success: true, rowsAffected: 1 };
  });
  db.batch.mockImplementation(async (statements: Array<{ sql: string; params?: unknown[] }>) =>
    statements.map((statement) => {
      written.push({ sql: statement.sql, params: statement.params ?? [] });
      return { success: true, rowsAffected: 1 };
    })
  );
  db.transaction.mockImplementation(async (fn: (tx: DatabaseAdapter) => Promise<unknown>) =>
    fn({
      execute: vi.fn(async (sql: string, params?: unknown[]) => {
        written.push({ sql, params: params ?? [] });
        return { success: true, rowsAffected: 1 };
      }),
    } as unknown as DatabaseAdapter)
  );
  mocks.getFeatureFlag.mockImplementation(
    (_key: string, env: Env) =>
      (env as Env & { ENABLE_LOGIN_RUNTIME_FLOW?: string }).ENABLE_LOGIN_RUNTIME_FLOW === 'true'
  );
}

export type RuntimeContext = Context<{ Bindings: Env }>;

export interface ContextInput {
  body?: unknown;
  env?: Record<string, unknown>;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  url?: string;
}

export function createContext(input: ContextInput = {}): RuntimeContext & {
  header: ReturnType<typeof vi.fn>;
} {
  const url = input.url ?? 'https://first.test.authrim.com/api/v1/login/interactions/start';
  const headers = input.headers ?? {};
  const lookup = (name: string) =>
    headers[name] ??
    Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const request = {
    json: vi.fn(async () => input.body ?? {}),
    param: vi.fn((name: string) => input.params?.[name] ?? ''),
    header: vi.fn((name: string) => lookup(name)),
    url,
    raw: { headers: { get: (name: string) => lookup(name) ?? null } },
  };
  return {
    req: request,
    env: {
      ENABLE_LOGIN_RUNTIME_FLOW: 'true',
      FLOW_RUNTIME_HMAC_SECRET: 'flow-runtime-secret',
      ...input.env,
    } as unknown as Env,
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    header: vi.fn(),
  } as unknown as RuntimeContext & { header: ReturnType<typeof vi.fn> };
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const data: unknown = await response.json();
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

export const loginRuntime: FlowRuntimeContract = {
  flow_kind: 'login',
  ui: {
    steps: [
      {
        id: 'auth:step',
        source_node_id: 'auth',
        component: 'authentication_method_selector',
        render: true,
      },
      { id: 'complete:step', source_node_id: 'complete', component: 'completion', render: true },
    ],
  },
};

export function assignmentRow(overrides: Record<string, unknown> = {}) {
  return {
    flow_id: 'flow_login',
    target_type: 'tenant',
    target_id: null,
    flow_kind: 'login',
    published_version_id: 'fv_1',
    ...overrides,
  };
}

export function versionRow(
  runtimeSnapshot: unknown = loginRuntime,
  editorSnapshot: unknown = null,
  overrides: Record<string, unknown> = {}
) {
  return {
    id: 'fv_1',
    flow_id: 'flow_login',
    schema_version: 'authrim.login_ui.contract.v1',
    runtime_snapshot_json:
      typeof runtimeSnapshot === 'string' ? runtimeSnapshot : JSON.stringify(runtimeSnapshot),
    editor_snapshot_json:
      editorSnapshot === null
        ? null
        : typeof editorSnapshot === 'string'
          ? editorSnapshot
          : JSON.stringify(editorSnapshot),
    published_at: 1782770000,
    ...overrides,
  };
}

/** The assignment and version reads of a start (tenant default assignment). */
export function mockStart(runtimeSnapshot: unknown = loginRuntime, editorSnapshot: unknown = null) {
  mocks.coreAdapter.queryOne
    .mockResolvedValueOnce(assignmentRow())
    .mockResolvedValueOnce(versionRow(runtimeSnapshot, editorSnapshot));
}

/** An authorization challenge (an OIDC request) the start reads, for client `client_1`. */
export function challenge(overrides: Record<string, unknown> = {}) {
  const { metadata, ...rest } = overrides;
  return {
    id: 'login_challenge_1',
    tenantId: 'tenant_test',
    type: 'login',
    userId: 'anonymous',
    challenge: 'login_challenge_1',
    metadata: { client_id: 'client_1', ...(metadata as Record<string, unknown> | undefined) },
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
    consumed: false,
    ...rest,
  };
}

/** The INSERT of the interaction a start wrote, and the context it stored. */
export function insertedInteraction(): { params: unknown[]; context: Record<string, unknown> } {
  const insert = written.find((entry) => entry.sql.includes('INSERT INTO flow_interactions'));
  if (!insert) throw new Error('no interaction was inserted');
  return {
    params: insert.params,
    context: JSON.parse(String(insert.params[8])) as Record<string, unknown>,
  };
}

type Step = FlowRuntimeContract['ui']['steps'][number];

export function contractStep(data: Record<string, unknown>, stepId: string): Step | undefined {
  return (data.contract as FlowRuntimeContract | undefined)?.ui.steps.find(
    (step) => step.id === stepId
  );
}
