/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- admin API response bodies and hono/vi fakes are untyped in these route tests */
/**
 * Shared fakes for the custom-claims mutation tests: an in-memory SQL router standing in for the
 * core database, a Hono-like context, and the ar-lib-core override factory used with `vi.mock`.
 * Nothing here touches a network, a real database or a timer.
 */
import { vi } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

export type Row = Record<string, unknown>;

/** What the fake database answers; each test sets what it needs. */
export interface ClaimsDbState {
  /** The row answering `WHERE id = ? AND tenant_id = ?`. */
  schema: Row | null;
  /** The row answering the active field_key lookup (a conflict). */
  conflict: Row | null;
  /** Rows answering any other SELECT, by SQL fragment. */
  rowsFor: Array<{ includes: string; rows: Row[] | (() => Row[]) }>;
  /** `rowsAffected` for each statement (default 1). */
  rowsAffected: (sql: string, params: unknown[]) => number;
  /** A statement that must throw. */
  failOn: (sql: string, params: unknown[]) => Error | null;
  queries: Array<{ sql: string; params: unknown[] }>;
  executes: Array<{ sql: string; params: unknown[] }>;
}

export function createClaimsDb() {
  const state: ClaimsDbState = {
    schema: null,
    conflict: null,
    rowsFor: [],
    rowsAffected: () => 1,
    failOn: () => null,
    queries: [],
    executes: [],
  };
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    state.queries.push({ sql, params });
    const failure = state.failOn(sql, params);
    if (failure) throw failure;
    if (sql.includes('FROM custom_claim_schemas WHERE id = ? AND tenant_id = ?')) {
      return state.schema ? [{ ...state.schema }] : [];
    }
    if (sql.includes('active_field_key = ?')) {
      return state.conflict ? [{ ...state.conflict }] : [];
    }
    for (const entry of state.rowsFor) {
      if (sql.includes(entry.includes)) {
        return typeof entry.rows === 'function' ? entry.rows() : entry.rows;
      }
    }
    return [];
  });
  const adapter = {
    query,
    queryOne: vi.fn(async (sql: string, params: unknown[] = []) => {
      const rows = await query(sql, params);
      return rows[0] ?? null;
    }),
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      state.executes.push({ sql, params });
      const failure = state.failOn(sql, params);
      if (failure) throw failure;
      return { success: true, rowsAffected: state.rowsAffected(sql, params) };
    }),
    transaction: vi.fn(),
    batch: vi.fn(),
    isHealthy: vi.fn(async () => true),
    getType: vi.fn(() => 'mock'),
    close: vi.fn(),
  };
  return { adapter, state };
}

export function createKv() {
  const store = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({ keys: [] })),
  };
  return { kv: kv as unknown as KVNamespace, store, spies: kv };
}

export const PII_DB = { marker: 'pii-db' };

export function createClaimsContext(options: {
  db: ReturnType<typeof createClaimsDb>['adapter'];
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  jsonRejects?: boolean;
  kv?: KVNamespace;
  settingsKv?: KVNamespace | null;
}) {
  const kv = options.kv ?? createKv().kv;
  const store = new Map<string, unknown>([
    ['tenantId', 'test-tenant'],
    ['adminAuth', { userId: 'admin-1', authMethod: 'password' }],
    ['tenantMetadataContext', { tenantId: 'test-tenant', coreDb: options.db, route: {} }],
  ]);
  const c = {
    req: {
      param: vi.fn((name: string) => options.params?.[name]),
      query: vi.fn((name: string) => options.query?.[name]),
      json: vi.fn(async () => {
        if (options.jsonRejects) throw new SyntaxError('bad json');
        return options.body ?? {};
      }),
      header: vi.fn(() => null),
    },
    env: {
      DB: options.db,
      DB_PII: PII_DB,
      SETTINGS: options.settingsKv === undefined ? kv : (options.settingsKv ?? undefined),
      AUTHRIM_CONFIG: kv,
    } as unknown as Env,
    json: vi.fn((body: unknown, status = 200) => new Response(JSON.stringify(body), { status })),
    get: vi.fn((key: string) => store.get(key)),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
  };
  return c as any;
}

export async function read(response: Response | void): Promise<{ status: number; body: any }> {
  if (!response) throw new Error('handler returned no response');
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

/** A schema row as the database returns it. */
export function schemaRow(overrides: Row = {}): Row {
  return {
    id: 'schema-1',
    tenant_id: 'test-tenant',
    field_key: 'employee_id',
    display_label: 'Employee ID',
    field_type: 'string',
    cardinality: 'single',
    is_pii: 0,
    is_required: 0,
    is_active: 1,
    is_system: 0,
    validation_rules: null,
    required_scopes: null,
    scope_mode: 'any',
    claim_namespace: null,
    description: null,
    display_order: 0,
    schema_version: 1,
    operation_status: 'active',
    operation_detail: null,
    created_by: 'admin-1',
    created_at: 1700000000,
    updated_at: 1700000000,
    ...overrides,
  };
}

/**
 * Spies behind the ar-lib-core override. Hoisted into the harness so the test files and the
 * `vi.mock` factory (which runs in the harness module) share them.
 */
export const libCore = {
  audit: vi.fn(async () => {}),
  history: { recordChange: vi.fn(async () => {}), listVersions: vi.fn(), getVersion: vi.fn() },
  deleteStored: vi.fn(),
  renameStored: vi.fn(),
  countNonPiiUsers: vi.fn(),
  countPiiUsers: vi.fn(),
  listNonPiiFieldUsage: vi.fn(),
  countNonPiiField: vi.fn(),
  countPiiField: vi.fn(),
  heldValues: vi.fn(),
  violations: vi.fn(),
  runtimeUser: vi.fn(),
  nonPiiStores: [] as unknown[],
  piiStores: [] as unknown[],
  schemaDb: null as unknown,
  generatedIds: [] as string[],
  layered: vi.fn(),
  invalidate: vi.fn(async () => {}),
  /** Every error response made: the code and the variables it was given. */
  errors: [] as Array<{ code: string; variables: Record<string, unknown> | undefined }>,
};

/** The `vi.mock('@authrim/ar-lib-core')` factory. */
export async function buildLibCoreOverride(
  importOriginal: () => Promise<typeof import('@authrim/ar-lib-core')>
) {
  const actual = await importOriginal();
  return {
    ...actual,
    createErrorResponse: (
      c: unknown,
      code: string,
      details?: { variables?: Record<string, unknown> }
    ) => {
      libCore.errors.push({ code, variables: details?.variables });
      return (actual.createErrorResponse as any)(c, code, details);
    },
    generateId: () => libCore.generatedIds.shift() ?? 'generated-id',
    createAuditLogFromContext: (...args: unknown[]) => (libCore.audit as any)(...args),
    getTenantIdFromContext: () => 'test-tenant',
    ensureDatabaseAdapter: (db: unknown) => db,
    CustomClaimSchemaHistoryManager: vi.fn().mockImplementation(function MockHistory() {
      return libCore.history;
    }),
    SchemaLoader: vi.fn().mockImplementation(function MockLoader() {
      return { invalidateCache: libCore.invalidate };
    }),
    resolveCustomClaimRuntimeSourcesFromEnv: vi.fn(async () => ({
      schemaDb: libCore.schemaDb,
      nonPiiDb: libCore.schemaDb,
      piiDb: PII_DB,
    })),
    resolveTenantAssignedDatabaseSourcesFromRegistry: vi.fn(
      async (_env: unknown, options: { role: string }) =>
        (options.role === 'tenant_pii' ? libCore.piiStores : libCore.nonPiiStores).map(
          (source) => ({ source })
        )
    ),
    deleteStoredCustomClaimData: (...args: unknown[]) => (libCore.deleteStored as any)(...args),
    renameStoredCustomClaimData: (...args: unknown[]) => (libCore.renameStored as any)(...args),
    countUsersWithNonPiiCustomClaimData: (...args: unknown[]) =>
      (libCore.countNonPiiUsers as any)(...args),
    countUsersWithPiiCustomClaimData: (...args: unknown[]) =>
      (libCore.countPiiUsers as any)(...args),
    listNonPiiFieldUsage: (...args: unknown[]) => (libCore.listNonPiiFieldUsage as any)(...args),
    countUsersWithNonPiiFieldData: (...args: unknown[]) =>
      (libCore.countNonPiiField as any)(...args),
    countUsersWithPiiFieldData: (...args: unknown[]) => (libCore.countPiiField as any)(...args),
    findHeldNonPiiValuesOutside: (...args: unknown[]) => (libCore.heldValues as any)(...args),
    getRequiredCustomClaimViolationStatuses: (...args: unknown[]) =>
      (libCore.violations as any)(...args),
    layerTenantSettingsDocument: (...args: unknown[]) => (libCore.layered as any)(...args),
    CanonicalRuntimeUserStore: class {
      findById(userId: string, opts: unknown) {
        return libCore.runtimeUser(userId, opts);
      }
    },
  };
}

export function resetLibCore(): void {
  for (const fn of Object.values(libCore)) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  libCore.history.recordChange.mockReset();
  libCore.history.recordChange.mockResolvedValue(undefined);
  libCore.history.listVersions.mockReset();
  libCore.history.getVersion.mockReset();
  libCore.audit.mockResolvedValue(undefined);
  libCore.invalidate.mockResolvedValue(undefined);
  libCore.nonPiiStores = [];
  libCore.piiStores = [];
  libCore.schemaDb = null;
  libCore.generatedIds = [];
  libCore.errors = [];
  libCore.layered.mockImplementation(async (_env: unknown, _cat: string, doc: Row) => doc);
}
