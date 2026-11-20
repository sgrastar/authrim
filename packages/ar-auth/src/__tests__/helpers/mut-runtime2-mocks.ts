/**
 * The mocked stores and request helpers of the LoginUI runtime Flow handler tests
 * (login-runtime-flow.ts), shared by the mut-runtime2-* tests. The same fakes as
 * login-runtime-flow.test.ts: a test file mocks the modules with the factories below
 * (`vi.mock(id, async (orig) => (await import('./helpers/mut-runtime2-mocks')).mockLibCore(...))`);
 * mut-runtime2-requests.ts holds the request helpers.
 */
import { vi } from 'vitest';

type LibCore = typeof import('@authrim/ar-lib-core');

function createMocks() {
  type Executed = { success: boolean; rowsAffected?: number };
  const coreAdapter = {
    query: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>(),
    queryOne: vi.fn<(sql: string, params?: unknown[]) => Promise<unknown>>(),
    execute: vi.fn<(sql: string, params?: unknown[]) => Promise<Executed>>(),
    transaction: vi.fn(),
    batch: vi.fn<(statements: Array<{ sql: string; params?: unknown[] }>) => Promise<Executed[]>>(),
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
  const piiAdapter = {
    execute: vi.fn(async (..._args: unknown[]) => ({ rowsAffected: 1 })),
  };
  const publishEvent = vi.fn(
    async (
      ..._args: unknown[]
    ): Promise<{
      success: boolean;
      errors?: Array<{ target: string; name: string; error: string; retryable: boolean }>;
    }> => ({ success: true })
  );
  const sessionStore = {
    getSessionRpc: vi.fn(),
  };
  const challengeStore = {
    getChallengeRpc: vi.fn(),
    storeChallengeRpc: vi.fn(),
    consumeChallengeRpc: vi.fn(),
  };
  const runtimeUsers = {
    findById: vi.fn(),
    updateProfileFields: vi.fn(async (..._args: unknown[]): Promise<boolean> => true),
    hasProfile: vi.fn(async (..._args: unknown[]): Promise<boolean> => true),
  };
  const idQueue = ['interaction_1', 'step_1', 'audit_1', 'audit_2', 'step_2', 'audit_3'];

  /**
   * The statements and the subject's statement consents (user_consent_records), standing in for
   * the ar-lib-core readers and the atomic write (those are tested in ar-lib-core). The rules a
   * decision follows are the real ones: an agreement to a version that is not the current one is
   * `document_changed`, and a decline of an agreement is a withdrawal.
   */
  type FakeStatement = {
    id: string;
    slug: string;
    category: string;
    version_id: string;
    version: string;
    required_consent_version: string | null;
    active: boolean;
  };
  type FakeStatementRecord = {
    status: 'granted' | 'denied' | 'withdrawn';
    version: string;
    expires_at: number | null;
    updated_at?: number;
  };
  const statementFake = {
    statements: new Map<string, FakeStatement>(),
    records: new Map<string, FakeStatementRecord>(),
    /** Every decision written, in order. */
    writes: [] as Array<{
      userId: string;
      statementId: string;
      decision: 'granted' | 'denied';
      version: string;
      versionId: string;
      clientId?: string;
    }>,
    reset() {
      this.statements.clear();
      this.records.clear();
      this.writes.length = 0;
    },
    seed(statement: Partial<FakeStatement> & { id: string }) {
      this.statements.set(statement.id, {
        slug: statement.id,
        category: 'terms_of_service',
        version_id: `${statement.id}_v1`,
        version: '20260701',
        required_consent_version: null,
        active: true,
        ...statement,
      });
    },
    answer(userId: string, statementId: string, record: Partial<FakeStatementRecord> = {}) {
      this.records.set(`${userId}:${statementId}`, {
        status: 'granted',
        version: '20260701',
        expires_at: null,
        ...record,
      });
    },
    record(userId: string, statementId: string) {
      return this.records.get(`${userId}:${statementId}`) ?? null;
    },
  };

  return {
    statementFake,
    resolveStatementRequirements: vi.fn(
      async (
        _db: unknown,
        _tenantId: string,
        entries: ReadonlyArray<{ statement_id: string; required: boolean }>
      ) =>
        entries.flatMap((entry, order) => {
          const statement = statementFake.statements.get(entry.statement_id);
          if (!statement || !statement.active) return [];
          return [
            {
              statement_id: statement.id,
              statement: { id: statement.id, slug: statement.slug, category: statement.category },
              current_version: {
                id: statement.version_id,
                version: statement.version,
                status: 'active',
              },
              is_required: entry.required,
              min_version: statement.required_consent_version ?? statement.version,
              display_order: order,
            },
          ];
        })
    ),
    readStatementConsentDefinition: vi.fn(
      async (_db: unknown, _tenantId: string, statementId: string) => {
        const statement = statementFake.statements.get(statementId);
        return statement
          ? {
              statement_id: statement.id,
              version_id: statement.version_id,
              version: statement.version,
              content_hash: null,
              is_active: statement.active ? 1 : 0,
              version_status: 'active',
              withdrawal_allowed: true,
              required_consent_version: statement.required_consent_version,
            }
          : null;
      }
    ),
    readStatementConsentRecord: vi.fn(
      async (_account: unknown, _tenantId: string, userId: string, statementId: string) =>
        statementFake.record(userId, statementId)
    ),
    processConsentItemDecisions: vi.fn(
      async (
        _stores: unknown,
        _tenantId: string,
        userId: string,
        decisions: Record<string, 'granted' | 'denied'>,
        evidence: { client_id?: string },
        _ipHash: string | undefined,
        targets: Record<string, { version_id: string; version: string }> = {}
      ) => {
        for (const [statementId, decision] of Object.entries(decisions)) {
          const target = targets[statementId];
          const statement = statementFake.statements.get(statementId);
          if (!statement) {
            if (target) throw new Error('document_changed');
            continue;
          }
          if (target && target.version !== statement.version) throw new Error('document_changed');
          if (decision === 'granted' && !statement.active) throw new Error('document_changed');
          const before = statementFake.record(userId, statementId);
          if (decision === 'denied' && before?.status === 'denied') continue;
          statementFake.records.set(`${userId}:${statementId}`, {
            status:
              decision === 'granted'
                ? 'granted'
                : before?.status === 'granted'
                  ? 'withdrawn'
                  : 'denied',
            version: statement.version,
            expires_at: null,
            updated_at: Date.now(),
          });
          statementFake.writes.push({
            userId,
            statementId,
            decision,
            version: statement.version,
            versionId: statement.version_id,
            clientId: evidence.client_id,
          });
        }
      }
    ),
    piiAdapter,
    publishEvent,
    coreAdapter,
    emitLog: vi.fn(
      async (
        _env: unknown,
        _input: import('@authrim/ar-lib-core/services/log-iceberg-emitter').LogIcebergRowWrite
      ) => {}
    ),
    adminAdapter,
    sessionStore,
    challengeStore,
    runtimeUsers,
    resolveRuntimeIdentityMappingBinding: vi.fn(),
    resolveOidcIdentityMappingBinding: vi.fn(),
    idQueue,
    consumeAuthorizationChallengeContinuation: vi.fn(),
    flowCompletionRedirect: vi.fn(async (..._args: unknown[]): Promise<string | null> => null),
    readAuthorizationChallengeFreshness: vi.fn(),
    getFeatureFlag: vi.fn(),
    resolveAccountCoreDataContext: vi.fn(),
    readConditionAttributes: vi.fn(),
    resolveAccountDataContextFromHono: vi.fn(async () => undefined),
    resolveCustomClaimRuntimeSourcesFromHono: vi.fn(),
    validateCustomClaimWrite: vi.fn(),
    persistCustomClaimWrite: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

export const mocks = createMocks();

/** The real module, kept by mockLibCore (the reading of an app's Mapping Set choice is real). */
export let libCore: LibCore | undefined;

/** The '@authrim/ar-lib-core' module with the fakes in place. */
export function mockLibCore(actual: LibCore) {
  libCore = actual;
  return {
    ...actual,
    createAuthContextFromHono: vi.fn(() => ({
      coreAdapter: mocks.coreAdapter,
    })),
    createAccountAuthContextFromHono: vi.fn(() => ({ coreAdapter: mocks.coreAdapter })),
    resolveStatementRequirements: mocks.resolveStatementRequirements,
    readStatementConsentDefinition: mocks.readStatementConsentDefinition,
    readStatementConsentRecord: mocks.readStatementConsentRecord,
    processConsentItemDecisions: mocks.processConsentItemDecisions,
    resolveAccountDataContextFromHono: mocks.resolveAccountDataContextFromHono,
    createPIIContextFromHono: vi.fn(() => ({ defaultPiiAdapter: mocks.piiAdapter })),
    publishEvent: mocks.publishEvent,
    CanonicalRuntimeUserStore: class {
      findById(...args: unknown[]): unknown {
        return mocks.runtimeUsers.findById(...args);
      }
      updateProfileFields(...args: unknown[]) {
        return mocks.runtimeUsers.updateProfileFields(...args);
      }
      hasProfile(...args: unknown[]) {
        return mocks.runtimeUsers.hasProfile(...args);
      }
    },
    resolveCustomClaimRuntimeSourcesFromHono: mocks.resolveCustomClaimRuntimeSourcesFromHono,
    validateCustomClaimWrite: mocks.validateCustomClaimWrite,
    persistCustomClaimWrite: mocks.persistCustomClaimWrite,
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
    resolveOidcIdentityMappingBinding: mocks.resolveOidcIdentityMappingBinding,
    resolveAccountCoreDataContext: mocks.resolveAccountCoreDataContext,
    flowConditionAttributeReader: vi.fn(
      () => (keys: string[]) => mocks.readConditionAttributes(keys) as Promise<unknown>
    ),
  };
}

export function mockDirectAuth(actual: typeof import('../../direct-auth')) {
  return {
    consumeAuthorizationChallengeContinuation: mocks.consumeAuthorizationChallengeContinuation,
    readAuthorizationChallengeFreshness: mocks.readAuthorizationChallengeFreshness,
    isProofOlderThanChallengeRequirement: actual.isProofOlderThanChallengeRequirement,
    reauthProofFromRecord: actual.reauthProofFromRecord,
  };
}

export function mockRegistrationPolicyGate(
  actual: typeof import('../../registration-policy-gate')
) {
  return { ...actual, flowCompletionRedirect: mocks.flowCompletionRedirect };
}

/** The audit rows written (through the log emitter), in order. */
export function auditRows(): Array<{
  overview: Record<string, unknown>;
  row: Record<string, unknown>;
}> {
  return mocks.emitLog.mock.calls.map(
    ([, written]) =>
      written as unknown as { overview: Record<string, unknown>; row: Record<string, unknown> }
  );
}
