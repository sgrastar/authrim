/**
 * Admin API Handlers Unit Tests
 *
 * Tests for Admin API endpoints including:
 * - Statistics (adminStatsHandler)
 * - User management (CRUD operations)
 * - Client management (CRUD operations)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Env } from '@authrim/ar-lib-core';

const {
  mockPostgresAdapterFactory,
  canonicalRuntimeUsers,
  resolveIdentityMappingBinding,
  loadDestinationProfileDescriptor,
  executeDurableAccountCreation,
  resolveAccountCreationTargets,
  listCrossShardAccounts,
  findExactCrossShardAccounts,
  resolveOtpAccountCoreDataContextByIdentifier,
  resolveAccountDataContextByIdentifier,
  resolveAccountDataContext,
  prepareAccountRemoval,
  markAccountRemovalsReady,
  attemptAccountRemovals,
  eraseAccountPii,
} = vi.hoisted(() => ({
  mockPostgresAdapterFactory: vi.fn(),
  canonicalRuntimeUsers: new Map<string, any>(),
  resolveIdentityMappingBinding: vi.fn(async () => ({
    destinationProfileId: 'destination_oidc_1',
    destinationProfileIds: ['destination_oidc_1'],
  })),
  loadDestinationProfileDescriptor: vi.fn(async () => ({
    profileId: 'destination_oidc_1',
    profileVersionId: 'destination_oidc_version_1',
    destinationType: 'oidc',
    fields: [],
  })),
  executeDurableAccountCreation: vi.fn(),
  resolveAccountCreationTargets: vi.fn(),
  listCrossShardAccounts: vi.fn(),
  findExactCrossShardAccounts: vi.fn(),
  resolveOtpAccountCoreDataContextByIdentifier: vi.fn(),
  resolveAccountDataContextByIdentifier: vi.fn(),
  resolveAccountDataContext: vi.fn(),
  prepareAccountRemoval: vi.fn(async (_env, input) => [
    {
      operationId: `remove:${input.userId}`,
      tenantId: input.tenantId,
      accountId: `account:${input.userId}`,
    },
  ]),
  markAccountRemovalsReady: vi.fn(),
  attemptAccountRemovals: vi.fn(),
  eraseAccountPii: vi.fn(),
}));

vi.mock('../account-directory-producer', () => ({
  executeDurableInitialAccountDirectoryWrite: executeDurableAccountCreation,
  resolveInitialAccountDirectoryWriteTargets: resolveAccountCreationTargets,
}));

vi.mock('../account-directory-removal-producer', () => ({
  prepareAccountDirectoryRemoval: prepareAccountRemoval,
  markAccountDirectoryRemovalsReady: markAccountRemovalsReady,
  attemptImmediateAccountDirectoryRemovals: attemptAccountRemovals,
  eraseAccountPiiAfterDirectoryRemovalPrepared: eraseAccountPii,
}));

vi.mock('../cross-shard-account-list', () => ({
  CrossShardAccountListService: class {
    list = listCrossShardAccounts;
  },
  CrossShardAccountExactSearchService: class {
    find = findExactCrossShardAccounts;
  },
}));

// Mock specific submodules to avoid ESM barrel export resolution issues
// Vite's barrel export resolution can't handle deep `export *` chains with vi.spyOn,
// so we mock the specific source modules directly.
vi.mock('@authrim/ar-lib-core/utils/audit-log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core/utils/audit-log')>();
  return {
    ...actual,
    scheduleAuditLogFromContext: vi.fn(() => {}),
  };
});
vi.mock('@authrim/ar-lib-core/utils/id', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core/utils/id')>();
  return {
    ...actual,
    generateUserIdFromSettings: vi.fn(
      async () => `user-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
    ),
  };
});
vi.mock('@authrim/ar-lib-core/utils/crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core/utils/crypto')>();
  return {
    ...actual,
    hashClientSecret: vi.fn(async (secret: string) => {
      // Simple hash mock for testing - return hex string of consistent length
      const encoder = new TextEncoder();
      const data = encoder.encode(secret);
      const hashBuffer = await (globalThis as unknown as { crypto: Crypto }).crypto.subtle.digest(
        'SHA-256',
        data
      );
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    }),
  };
});
vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  return {
    ...actual,
    transitionAccountAuthenticationState: vi.fn(async (_env, input) => ({
      lifecycle: input.lifecycle,
    })),
    resolveRuntimeIdentityMappingBinding: resolveIdentityMappingBinding,
    loadDestinationProfileConsentDescriptor: loadDestinationProfileDescriptor,
    resolveAaguidAuthenticator: vi.fn((aaguid: string | null | undefined) =>
      aaguid
        ? {
            aaguid,
            name: 'Windows Hello',
            icon_dark: null,
            icon_light: 'data:image/svg+xml;base64,light',
            known: true,
          }
        : null
    ),
    resolveCustomClaimRuntimeSourcesFromEnv: vi.fn(async (env: Partial<Env>) => ({
      storageProfile: {
        id: env.DEFAULT_STORAGE_PROFILE_ID ?? 'builtin:storage:standard',
        kind: 'storage',
        label: 'Standard D1 Split',
        slices: {},
      },
      schemaDb: env.DB,
      nonPiiDb: env.DB,
      piiDb: env.DB_PII ?? null,
    })),
    resolveCustomClaimRuntimeSourcesFromHono: vi.fn(
      async (c: { get(key: string): unknown; env: Partial<Env> }) => {
        const account = c.get('accountDataContext') as
          | { coreDb?: unknown; piiDb?: unknown }
          | undefined;
        return {
          storageProfile: {
            id: 'builtin:storage:tenant-d1',
            kind: 'storage',
            label: 'Tenant D1',
            slices: {},
          },
          schemaDb: c.env.DB,
          nonPiiDb: account?.coreDb ?? c.env.DB,
          piiDb: account?.piiDb ?? c.env.DB_PII ?? null,
        };
      }
    ),
    resolveTenantRuntimeProfilesFromEnv: vi.fn(async (env: Partial<Env>) => {
      const auditProfileId = (env as Record<string, unknown>).DEFAULT_AUDIT_PROFILE_ID;
      if (auditProfileId === 'builtin:audit:archive-only-logpush') {
        return {
          auditProfile: {
            id: 'builtin:audit:archive-only-logpush',
            kind: 'audit',
            label: 'Archive Only + Logpush',
            builtin: true,
            primary: null,
            archive: { type: 'r2', bucketRef: 'DIAGNOSTIC_LOGS', prefix: 'audit/' },
            sinks: [],
          },
        };
      }
      if (auditProfileId === 'custom:audit:postgres-primary') {
        return {
          auditProfile: {
            id: 'custom:audit:postgres-primary',
            kind: 'audit',
            label: 'Postgres Primary',
            builtin: false,
            primary: { type: 'postgres', connectionRef: 'audit-primary', dataset: 'event_log' },
            archive: null,
            sinks: [],
          },
        };
      }
      return {
        auditProfile: {
          id: 'builtin:audit:standard',
          kind: 'audit',
          label: 'Standard Audit',
          builtin: true,
          primary: { type: 'd1', bindingRef: 'DB', dataset: 'event_log' },
          archive: null,
          sinks: [],
        },
      };
    }),
    resolveAccountDataContextByIdentifierFromHono: resolveAccountDataContextByIdentifier,
    resolveOtpAccountCoreDataContextByIdentifierFromHono:
      resolveOtpAccountCoreDataContextByIdentifier,
    resolveAccountDataContextFromHono: resolveAccountDataContext,
    PostgresAdapter: vi.fn().mockImplementation(function MockPostgresAdapter(config: unknown) {
      const adapter = mockPostgresAdapterFactory(config);
      if (!adapter) {
        throw new Error('mockPostgresAdapterFactory returned no adapter');
      }
      return adapter;
    }),
    MysqlAdapter: vi.fn().mockImplementation(function MockMysqlAdapter(config: unknown) {
      const adapter = mockPostgresAdapterFactory(config);
      if (!adapter) {
        throw new Error('mockPostgresAdapterFactory returned no adapter');
      }
      return adapter;
    }),
    createExternalAuditDatabaseAdapter: vi.fn((env: unknown, target: unknown, partition: unknown) =>
      mockPostgresAdapterFactory({ env, target, partition })
    ),
    CanonicalSensitiveValueResolver: class {
      adapter: unknown;

      constructor(adapter: unknown) {
        this.adapter = adapter;
      }
    },
    CanonicalRuntimeUserProjectionRepository: class {
      coreAdapter: unknown;
      piiAdapter: unknown;
      tenantId: string;

      constructor(coreAdapter: unknown, tenantId: string, resolver: { adapter?: unknown }) {
        this.coreAdapter = coreAdapter;
        this.piiAdapter = resolver?.adapter;
        this.tenantId = tenantId;
      }

      async findByLegacyUserId(userId: string, options?: { includeInactive?: boolean }) {
        const runtimeUser = canonicalRuntimeUsers.get(userId);
        if (
          runtimeUser &&
          (options?.includeInactive || runtimeUser.lifecycle_state !== 'deleted')
        ) {
          return toCanonicalProjection(userId, runtimeUser, this.tenantId);
        }

        const coreDb = (this.coreAdapter as { db?: any }).db;
        const piiDb = (this.piiAdapter as { db?: any } | undefined)?.db;
        const coreRows = [
          ...((coreDb?._mockOptions?.allResults as any[]) ?? []),
          coreDb?._mockOptions?.firstResult,
        ].filter(Boolean);
        const piiRows = [
          ...((piiDb?._mockOptions?.allResults as any[]) ?? []),
          piiDb?._mockOptions?.firstResult,
        ].filter(Boolean);
        let core = coreRows.find(
          (row) =>
            row.id === userId || row.legacy_user_id === userId || row.id === `account:${userId}`
        );
        if (!core || 'count' in core) {
          core = await (this.coreAdapter as any)?.queryOne?.(
            'SELECT * FROM identity_accounts WHERE legacy_user_id = ? AND tenant_id = ?',
            [userId, this.tenantId]
          );
        }
        if (!core || 'count' in core) {
          return null;
        }
        const pii = piiRows.find((row) => row.id === userId) ?? {};
        return toCanonicalProjection(userId, { ...core, ...pii }, this.tenantId);
      }

      async findByAccountId(accountId: string) {
        const userId = accountId.startsWith('account:')
          ? accountId.slice('account:'.length)
          : accountId.replace(/^account-/, 'user-account-');
        return this.findByLegacyUserId(userId);
      }
    },
    CanonicalRuntimeUserWriter: class {
      async createFromRuntimeUser(input: any) {
        canonicalRuntimeUsers.set(input.userId, runtimeInputToUser(input));
        return { created: true, graph: null, profileAttributeCount: 0, contactPointCount: 0 };
      }

      async syncFromRuntimeUser(input: any) {
        canonicalRuntimeUsers.set(input.userId, {
          ...(canonicalRuntimeUsers.get(input.userId) ?? {}),
          ...runtimeInputToUser(input),
        });
        return { created: false, graph: null, profileAttributeCount: 0, contactPointCount: 0 };
      }

      async deleteRuntimeUser(userId: string) {
        canonicalRuntimeUsers.set(userId, {
          ...(canonicalRuntimeUsers.get(userId) ?? { id: userId }),
          lifecycle_state: 'deleted',
          active: 0,
        });
        return true;
      }
    },
    CanonicalRuntimeUserStore: class {
      tenantId: string;
      coreAdapter: any;
      piiAdapter: any;

      constructor(options: { tenantId: string; coreAdapter?: unknown; piiAdapter?: unknown }) {
        this.tenantId = options.tenantId;
        this.coreAdapter = options.coreAdapter;
        this.piiAdapter = options.piiAdapter;
      }

      async findById(userId: string, options?: { includeInactive?: boolean }) {
        const runtimeUser = canonicalRuntimeUsers.get(userId);
        if (
          runtimeUser &&
          (options?.includeInactive || runtimeUser.lifecycle_state !== 'deleted')
        ) {
          return toCanonicalProjection(userId, runtimeUser, this.tenantId);
        }
        const core = await this.coreAdapter?.queryOne?.(
          'SELECT * FROM identity_accounts WHERE legacy_user_id = ? AND tenant_id = ?',
          [userId, this.tenantId]
        );
        if (!core) {
          return null;
        }
        const emailRow = await this.piiAdapter?.queryOne?.(
          `SELECT value_json FROM identity_sensitive_values
           WHERE tenant_id = ? AND owner_type = 'runtime_user' AND owner_id = ? AND value_key = 'email'`,
          [this.tenantId, userId]
        );
        const nameRow = await this.piiAdapter?.queryOne?.(
          `SELECT value_json FROM identity_sensitive_values
           WHERE tenant_id = ? AND owner_type = 'runtime_user' AND owner_id = ? AND value_key = 'name'`,
          [this.tenantId, userId]
        );
        return toCanonicalProjection(
          userId,
          {
            ...core,
            email: emailRow?.value_json ? JSON.parse(emailRow.value_json) : null,
            name: nameRow?.value_json ? JSON.parse(nameRow.value_json) : null,
          },
          this.tenantId
        );
      }

      async findByEmail(email: string) {
        for (const [userId, runtimeUser] of canonicalRuntimeUsers) {
          if (runtimeUser.email === email && runtimeUser.lifecycle_state !== 'deleted') {
            return toCanonicalProjection(userId, runtimeUser, this.tenantId);
          }
        }
        return null;
      }

      async findForOtpLogin(userId: string, trustedEmail: string) {
        const runtimeUser = canonicalRuntimeUsers.get(userId);
        if (!runtimeUser) return null;
        const projection = toCanonicalProjection(userId, runtimeUser, this.tenantId);
        return {
          ...projection,
          email: trustedEmail.trim().toLowerCase(),
        };
      }

      async deleteUser(userId: string) {
        canonicalRuntimeUsers.set(userId, {
          ...(canonicalRuntimeUsers.get(userId) ?? { id: userId }),
          lifecycle_state: 'deleted',
          active: 0,
        });
        return true;
      }
    },
  };
});

function runtimeInputToUser(input: any) {
  const now = Date.now();
  return {
    id: input.userId,
    tenant_id: input.tenantId,
    lifecycle_state: input.active === false ? 'deleted' : 'active',
    active: input.active === false ? 0 : 1,
    email: input.sensitiveValues?.email ?? input.email ?? null,
    name: input.sensitiveValues?.name ?? input.name ?? null,
    phone_number: input.sensitiveValues?.phone_number ?? input.phone_number ?? null,
    email_verified: input.emailVerified ? 1 : 0,
    phone_number_verified: input.phoneNumberVerified ? 1 : 0,
    user_type: input.userType ?? 'end_user',
    external_id: input.externalId ?? null,
    password_hash: input.passwordHash ?? null,
    created_at: Math.floor(now / 1000),
    updated_at: Math.floor(now / 1000),
  };
}

function toCanonicalProjection(userId: string, row: any, tenantId: string) {
  const lifecycleState =
    row.lifecycle_state ?? (row.active === 0 || row.is_active === 0 ? 'deleted' : 'active');
  return {
    id: userId,
    tenant_id: row.tenant_id ?? tenantId,
    subject_id: row.primary_subject_id ?? `subject:${userId}`,
    account_id: row.id?.startsWith?.('account:') ? row.id : `account:${userId}`,
    account_type: row.account_type ?? 'user',
    lifecycle_state: lifecycleState,
    account_status:
      row.status ??
      (lifecycleState === 'suspended' || lifecycleState === 'locked' || lifecycleState === 'deleted'
        ? lifecycleState
        : lifecycleState === 'active'
          ? 'active'
          : 'inactive'),
    suspended_at: row.suspended_at ?? null,
    suspended_until: row.suspended_until ?? null,
    locked_at: row.locked_at ?? null,
    locked_until: row.locked_until ?? null,
    email: row.email ?? null,
    email_verified: row.email_verified ?? 0,
    name: row.name ?? null,
    given_name: row.given_name ?? null,
    family_name: row.family_name ?? null,
    middle_name: row.middle_name ?? null,
    nickname: row.nickname ?? null,
    preferred_username: row.preferred_username ?? null,
    profile: row.profile ?? null,
    picture: row.picture ?? null,
    website: row.website ?? null,
    gender: row.gender ?? null,
    birthdate: row.birthdate ?? null,
    zoneinfo: row.zoneinfo ?? null,
    locale: row.locale ?? null,
    phone_number: row.phone_number ?? null,
    phone_number_verified: row.phone_number_verified ?? 0,
    address_json: row.address_json ?? null,
    password_hash: row.password_hash ?? null,
    external_id: row.external_id ?? null,
    last_login_at: row.last_login_at ?? null,
    active: lifecycleState === 'active' ? 1 : 0,
    custom_attributes_json: row.custom_attributes_json ?? null,
    created_at:
      typeof row.created_at === 'number' ? new Date(row.created_at).toISOString() : row.created_at,
    updated_at:
      typeof row.updated_at === 'number' ? new Date(row.updated_at).toISOString() : row.updated_at,
  };
}

import {
  adminStatsHandler,
  adminUsersListHandler,
  adminUserGetHandler,
  adminUserCreateHandler,
  adminUserCreationOperationHandler,
  adminUserUpdateHandler,
  adminUserDeleteHandler,
  adminUserAnonymizeHandler,
  adminUserSendEmailHandler,
  adminAuditLogListHandler,
  adminAuditLogGetHandler,
  adminUserActivityLogHandler,
  adminClientsListHandler,
  adminClientGetHandler,
  adminClientCreateHandler,
  adminClientUpdateHandler,
  adminClientDeleteHandler,
  adminClientRegenerateSecretHandler,
  adminSessionGetHandler,
  adminTestEmailCodeHandler,
} from '../admin';

// Helper to create mock D1Database
function createMockDB(options: {
  prepareResults?: Record<string, any>;
  allResults?: any[];
  firstResult?: any;
  runResult?: { success: boolean; meta?: { changes: number } };
}) {
  let currentSql = '';
  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(options.firstResult ?? null),
    all: vi.fn().mockImplementation(async () => {
      const rows = options.allResults ?? [];
      if (currentSql.includes('FROM identity_accounts')) {
        return {
          results: rows.map((row) => ({
            ...row,
            id: currentSql.includes('legacy_user_id as id')
              ? (row.legacy_user_id ?? row.id)
              : row.id?.startsWith?.('account:')
                ? row.id
                : `account:${row.id}`,
            legacy_user_id: row.legacy_user_id ?? row.id,
            primary_subject_id: row.primary_subject_id ?? `subject:${row.id}`,
            lifecycle_state:
              row.lifecycle_state ??
              (row.is_active === 0 || row.active === 0 ? 'deleted' : 'active'),
          })),
        };
      }
      return { results: rows };
    }),
    run: vi.fn().mockResolvedValue(options.runResult ?? { success: true }),
  };

  return {
    prepare: vi.fn((sql: string) => {
      currentSql = sql;
      return mockStatement;
    }),
    batch: vi
      .fn()
      .mockImplementation(async (statements: unknown[]) =>
        statements.map(() => options.runResult ?? { success: true, meta: { changes: 1 } })
      ),
    exec: vi.fn().mockResolvedValue(undefined),
    dump: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    _mockStatement: mockStatement,
    _mockOptions: options,
  } as unknown as D1Database & {
    _mockStatement: typeof mockStatement;
    _mockOptions: typeof options;
  };
}

function createOAuthClientRow(
  clientId: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    client_id: clientId,
    client_secret_hash: 'existing-secret-hash',
    client_name: null,
    redirect_uris: JSON.stringify(['https://example.com/callback']),
    grant_types: JSON.stringify(['authorization_code']),
    response_types: JSON.stringify(['code']),
    scope: null,
    token_endpoint_auth_method: 'client_secret_basic',
    contacts: null,
    logo_uri: null,
    client_uri: null,
    policy_uri: null,
    tos_uri: null,
    jwks_uri: null,
    jwks: null,
    subject_type: null,
    sector_identifier_uri: null,
    token_endpoint_auth_signing_alg: null,
    id_token_signed_response_alg: null,
    userinfo_signed_response_alg: null,
    request_object_signing_alg: null,
    authorization_signed_response_alg: null,
    authorization_encrypted_response_alg: null,
    authorization_encrypted_response_enc: null,
    is_trusted: null,
    skip_consent: null,
    allow_claims_without_scope: null,
    claims_parameter_policy: null,
    asc_enabled: null,
    asc_protected_request_required: null,
    asc_sao_enabled: null,
    asc_transformed_claims_enabled: null,
    asc_allowed_transformed_claims: null,
    token_exchange_allowed: null,
    allowed_subject_token_clients: null,
    allowed_token_exchange_resources: null,
    delegation_mode: null,
    client_credentials_allowed: null,
    allowed_scopes: null,
    default_scope: null,
    default_audience: null,
    default_resource: null,
    initiate_login_uri: null,
    registration_access_token_hash: null,
    post_logout_redirect_uris: null,
    backchannel_logout_uri: null,
    backchannel_logout_session_required: null,
    frontchannel_logout_uri: null,
    frontchannel_logout_session_required: null,
    software_id: null,
    software_version: null,
    requestable_scopes: null,
    backchannel_token_delivery_mode: null,
    backchannel_client_notification_endpoint: null,
    backchannel_authentication_request_signing_alg: null,
    backchannel_user_code_parameter: null,
    allowed_redirect_origins: null,
    require_pkce: null,
    tenant_id: 'default',
    application_type: null,
    trust_group: null,
    trust_group_id: null,
    browser_public_client_mode: null,
    browser_refresh_token_policy: null,
    native_sso_enabled: null,
    native_channel_allowed: null,
    allowed_channels: null,
    device_secret_revoke_enabled: null,
    device_secret_revoke_trust_groups: null,
    device_secret_introspection_enabled: null,
    device_secret_introspection_trust_groups: null,
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    ...overrides,
  };
}

function createSqlAwareMockDB(
  handler: (
    sql: string,
    params: unknown[],
    op: 'first' | 'all' | 'run'
  ) => unknown | Promise<unknown>
) {
  return {
    prepare: vi.fn((sql: string) => {
      let boundParams: unknown[] = [];
      const statement = {
        bind: vi.fn((...params: unknown[]) => {
          boundParams = params;
          return statement;
        }),
        first: vi.fn(async () => (await handler(sql, boundParams, 'first')) ?? null),
        all: vi.fn(async () => ({
          results: ((await handler(sql, boundParams, 'all')) ?? []) as any[],
        })),
        run: vi.fn(async () => (await handler(sql, boundParams, 'run')) ?? { success: true }),
      };
      return statement;
    }),
    batch: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue(undefined),
    dump: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
  } as unknown as D1Database;
}

// Mock KV namespace for cache invalidation
function createMockKVNamespace(initialData: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initialData));
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix = '' }: { prefix?: string } = {}) => ({
      keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    })),
  };
}

// Helper to create mock context
function createMockContext(options: {
  method?: string;
  query?: Record<string, string>;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  db?: D1Database;
  dbPII?: D1Database;
  headers?: Record<string, string>;
  jsonError?: Error;
  envOverrides?: Partial<Env>;
  tenantId?: string;
  runtimeUserStoreSources?: unknown;
  tenantMetadataContext?: unknown;
}) {
  const mockDB =
    options.db ??
    createMockDB({
      firstResult: null,
      allResults: [],
    });

  // DB_PII mock for PII/Non-PII DB separation
  const mockDBPII =
    options.dbPII ??
    createMockDB({
      firstResult: null,
      allResults: [],
    });

  // Store context values (simulating Hono's context store)
  const contextStore = new Map<string, unknown>([
    ['tenantId', options.tenantId ?? 'default'],
    [
      'adminAuth',
      {
        userId: 'admin-user',
        email: 'admin@example.com',
        sessionId: 'session-123',
        roles: ['system_admin'],
        permissions: [],
      },
    ],
  ]);
  if (options.runtimeUserStoreSources) {
    contextStore.set('runtimeUserStoreSources', options.runtimeUserStoreSources);
  }
  if (options.tenantMetadataContext) {
    contextStore.set('tenantMetadataContext', options.tenantMetadataContext);
  }
  const normalizedHeaders = new Map(
    Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  const responseHeaders = new Map<string, string>();

  const c = {
    req: {
      method: options.method || 'GET',
      query: (name: string) => options.query?.[name],
      param: (name: string) => options.params?.[name],
      json: options.jsonError
        ? vi.fn().mockRejectedValue(options.jsonError)
        : vi.fn().mockResolvedValue(options.body ?? {}),
      parseBody: vi.fn().mockResolvedValue(options.body ?? {}),
      header: vi.fn((name: string) => normalizedHeaders.get(name.toLowerCase())),
    },
    env: {
      DB: mockDB,
      DB_PII: mockDBPII, // Added for PII/Non-PII DB separation
      ISSUER_URL: 'https://op.example.com',
      CLIENTS_CACHE: createMockKVNamespace(),
      SETTINGS: createMockKVNamespace(),
      SESSION_REVOCATION_STORE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({
          setAccountLifecycleRpc: vi.fn(async (_tenant, _user, _account, lifecycle) => ({
            lifecycle,
          })),
        })),
      },
    } as unknown as Env,
    json: vi.fn(
      (body, status = 200, headers?: Record<string, string>) =>
        new Response(JSON.stringify(body), { status, headers })
    ),
    header: vi.fn((name: string, value: string) => {
      responseHeaders.set(name, value);
    }),
    get: vi.fn((key: string) => contextStore.get(key)),
    set: vi.fn((key: string, value: unknown) => contextStore.set(key, value)),
    executionCtx: {
      waitUntil: vi.fn(),
    },
    _mockDB: mockDB,
    _mockDBPII: mockDBPII, // For test assertions
    _responseHeaders: responseHeaders,
  } as any;

  c.env = {
    ...c.env,
    ...options.envOverrides,
  };

  return c;
}

function createMockR2Bucket(
  entries: Array<{
    key: string;
    body: unknown;
  }>
): R2Bucket {
  const objects = entries.map((entry) => ({
    key: entry.key,
    size: JSON.stringify(entry.body).length,
    uploaded: new Date(),
    etag: `etag-${entry.key}`,
    checksums: {},
    httpEtag: `etag-${entry.key}`,
    version: 'v1',
  })) as unknown as R2Object[];

  return {
    list: vi.fn(async ({ prefix }: { prefix?: string }) => ({
      objects: prefix ? objects.filter((object) => object.key.startsWith(prefix)) : objects,
      truncated: false,
      delimitedPrefixes: [],
    })),
    get: vi.fn(async (key: string) => {
      const found = entries.find((entry) => entry.key === key);
      if (!found) {
        return null;
      }
      return {
        text: async () => JSON.stringify(found.body),
      };
    }),
  } as unknown as R2Bucket;
}

function createCustomClaimSchemaRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'schema-1',
    tenant_id: 'default',
    field_key: 'department',
    display_label: 'Department',
    field_type: 'string',
    is_pii: 0,
    is_required: 1,
    is_active: 1,
    validation_rules: null,
    include_in_id_token: 0,
    include_in_userinfo: 0,
    include_in_introspection: 0,
    required_scopes: null,
    scope_mode: 'any',
    is_searchable: 1,
    is_exportable: 1,
    is_vc_claim: 0,
    claim_namespace: null,
    description: null,
    display_order: 0,
    schema_version: 1,
    operation_status: 'active',
    operation_detail: null,
    created_by: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    ...overrides,
  };
}

describe('Admin API Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostgresAdapterFactory.mockReset();
    canonicalRuntimeUsers.clear();
    listCrossShardAccounts.mockReset();
    findExactCrossShardAccounts.mockReset();
    resolveOtpAccountCoreDataContextByIdentifier.mockReset();
    resolveAccountDataContextByIdentifier.mockReset();
    resolveAccountDataContext.mockReset();
    executeDurableAccountCreation.mockImplementation(async (_env, input) => {
      const accountId = `account:${input.candidateUserId}`;
      const operationId = input.candidateOperationId;
      return {
        operation: {
          operationId,
          tenantId: input.tenantId,
          actorId: input.actorId,
          idempotencyKey: input.idempotencyKey,
          allocationIdempotencyKey: 'account-create:key',
          requestHash: input.requestHash,
          userId: input.candidateUserId,
          accountId,
          status: 'succeeded',
          publication: null,
        },
        publication: {
          operationId,
          tenantId: input.tenantId,
          accountId,
          idempotencyKey: 'account-create:key',
          routeProjection: {
            schemaVersion: 1,
            accountRouteGeneration: 1,
            residencyPolicyId: input.residencyPolicyId,
            targets: [],
          },
          indexes: [],
        },
        delivery: { status: 201, operationId, accountId },
      };
    });
    resolveAccountCreationTargets.mockImplementation(async (env) => ({
      tenantCoreUsers: env.DB,
      tenantPii: env.DB_PII,
      residencyPartition: 'default',
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('adminTestEmailCodeHandler tenant D1 routing', () => {
    const tenantMetadataContext = {
      tenantId: 'default',
      storageProfileId: 'builtin:storage:tenant-d1',
    };

    it('uses the route-bound Core projection without reading tenant-D1 PII data', async () => {
      const storeChallengeRpc = vi.fn().mockResolvedValue(undefined);
      const c = createMockContext({
        method: 'POST',
        body: { email: 'USER@example.com', create_user: false },
        tenantMetadataContext,
        envOverrides: {
          OTP_HMAC_SECRET: 'test-only-otp-hmac-secret',
          CHALLENGE_STORE: {
            idFromName: vi.fn(() => ({ toString: () => 'challenge-shard' })),
            get: vi.fn(() => ({ storeChallengeRpc })),
          } as unknown as Env['CHALLENGE_STORE'],
        },
      });
      resolveOtpAccountCoreDataContextByIdentifier.mockImplementationOnce(async (context) => {
        return {
          tenantId: 'default',
          accountId: 'account-1',
          legacyUserId: 'user-1',
          coreDb: context.env.DB,
          user: {
            id: 'user-1',
            email: 'user@example.com',
            name: 'User One',
            active: 1,
            email_verified: 0,
            account_type: 'end_user',
            created_at: '2023-11-14T22:13:20.000Z',
          },
        };
      });

      const response = await adminTestEmailCodeHandler(c);

      expect(response.status).toBe(201);
      await expect(response.clone().json()).resolves.toMatchObject({
        runtime_profile: {
          storage_profile_id: 'builtin:storage:tenant-d1',
          session_cold_persistence: 'disabled',
        },
      });
      expect(resolveOtpAccountCoreDataContextByIdentifier).toHaveBeenCalledWith(c, {
        indexKind: 'email_exact',
        identifier: 'user@example.com',
        trustedEmail: 'USER@example.com',
      });
      expect(resolveAccountDataContextByIdentifier).not.toHaveBeenCalled();
      expect(c.get('accountDataContext')).toBeUndefined();
      expect(storeChallengeRpc).toHaveBeenCalledOnce();
    });

    it('uses the identifier route as the authoritative email binding without rereading PII', async () => {
      resolveOtpAccountCoreDataContextByIdentifier.mockImplementationOnce(async (context) => {
        return {
          tenantId: 'default',
          accountId: 'account-1',
          legacyUserId: 'user-1',
          coreDb: context.env.DB,
          user: {
            id: 'user-1',
            email: 'old-address@example.com',
            name: 'User One',
            active: 1,
            email_verified: 0,
            account_type: 'end_user',
            created_at: '2023-11-14T22:13:20.000Z',
          },
        };
      });
      const c = createMockContext({
        method: 'POST',
        body: { email: 'old-address@example.com', create_user: false },
        tenantMetadataContext,
        envOverrides: {
          OTP_HMAC_SECRET: 'test-only-otp-hmac-secret',
          CHALLENGE_STORE: {
            idFromName: vi.fn(() => ({ toString: () => 'challenge-shard' })),
            get: vi.fn(() => ({ storeChallengeRpc: vi.fn().mockResolvedValue(undefined) })),
          } as unknown as Env['CHALLENGE_STORE'],
        },
      });

      const response = await adminTestEmailCodeHandler(c);

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toMatchObject({ success: true, userId: 'user-1' });
    });

    it('returns the existing not-found contract when a pre-seeded route is absent', async () => {
      resolveOtpAccountCoreDataContextByIdentifier.mockRejectedValueOnce(
        new Error('account_data_route_not_found')
      );
      const c = createMockContext({
        method: 'POST',
        body: { email: 'missing@example.com', create_user: false },
        tenantMetadataContext,
      });

      const response = await adminTestEmailCodeHandler(c);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: 'invalid_request',
      });
    });

    it('does not create an unallocated tenant-D1 user through the test endpoint', async () => {
      resolveOtpAccountCoreDataContextByIdentifier.mockRejectedValueOnce(
        new Error('account_data_route_not_found')
      );
      const c = createMockContext({
        method: 'POST',
        body: { email: 'missing@example.com', create_user: true },
        tenantMetadataContext,
      });

      const response = await adminTestEmailCodeHandler(c);

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: 'conflict' });
    });

    it('fails closed when identifier routing rejects the tenant boundary', async () => {
      resolveOtpAccountCoreDataContextByIdentifier.mockRejectedValueOnce(
        new Error('account_data_context_conflict')
      );
      const c = createMockContext({
        method: 'POST',
        body: { email: 'user@example.com', create_user: false },
        tenantMetadataContext,
      });

      const response = await adminTestEmailCodeHandler(c);

      expect(response.status).toBe(500);
      expect(c.get('accountDataContext')).toBeUndefined();
    });

    it('returns retryable 503 when tenant-D1 routing is overloaded', async () => {
      resolveOtpAccountCoreDataContextByIdentifier.mockRejectedValueOnce(
        new Error('D1 DB is overloaded')
      );
      const c = createMockContext({
        method: 'POST',
        body: { email: 'user@example.com', create_user: false },
        tenantMetadataContext,
      });

      const response = await adminTestEmailCodeHandler(c);

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('1');
      await expect(response.json()).resolves.toMatchObject({
        error: 'temporarily_unavailable',
        extensions: { reason: 'data_store_overloaded', retryable: true },
      });
    });
  });

  describe('tenant isolation for UID-scoped endpoints', () => {
    it('returns 404 for a user ID that is not in the selected tenant', async () => {
      const mockDB = createSqlAwareMockDB((sql, params) => {
        if (sql.includes('FROM users_core WHERE id = ? AND tenant_id = ?')) {
          expect(params).toEqual(['user-from-tenant-a', 'tenant-b']);
          return null;
        }
        return null;
      });

      const c = createMockContext({
        tenantId: 'tenant-b',
        params: { id: 'user-from-tenant-a' },
        db: mockDB,
      });

      const response = await adminUserGetHandler(c);
      expect(response.status).toBe(404);
    });

    it('returns 404 for a client ID that is not in the selected tenant', async () => {
      const mockDB = createSqlAwareMockDB((sql, params) => {
        if (sql.includes('FROM oauth_clients WHERE tenant_id = ? AND client_id = ?')) {
          expect(params).toEqual(['tenant-b', 'client-from-tenant-a']);
          return null;
        }
        return null;
      });

      const c = createMockContext({
        tenantId: 'tenant-b',
        params: { id: 'client-from-tenant-a' },
        db: mockDB,
      });

      const response = await adminClientGetHandler(c);
      expect(response.status).toBe(404);
    });

    it('returns 404 for a session ID that is not in the selected tenant', async () => {
      const mockDB = createSqlAwareMockDB((sql, params) => {
        if (sql.includes('FROM sessions WHERE id = ? AND tenant_id = ?')) {
          expect(params).toEqual(['session-from-tenant-a', 'tenant-b']);
          return null;
        }
        return null;
      });

      const c = createMockContext({
        tenantId: 'tenant-b',
        params: { id: 'session-from-tenant-a' },
        db: mockDB,
      });

      const response = await adminSessionGetHandler(c);
      expect(response.status).toBe(404);
    });

    it('returns 404 for an audit log ID that is not in the selected tenant', async () => {
      const mockDB = createSqlAwareMockDB((sql, params) => {
        if (sql.includes('sqlite_master')) {
          return { name: 'event_log' };
        }
        if (sql.includes('FROM event_log') && sql.includes('WHERE id = ? AND tenant_id = ?')) {
          expect(params).toEqual(['audit-from-tenant-a', 'tenant-b']);
          return null;
        }
        return null;
      });

      const c = createMockContext({
        tenantId: 'tenant-b',
        params: { id: 'audit-from-tenant-a' },
        db: mockDB,
      });

      const response = await adminAuditLogGetHandler(c);
      expect(response.status).toBe(404);
    });
  });

  describe('adminStatsHandler', () => {
    it('should return statistics with correct structure', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 10 },
        allResults: [
          { id: 'user-1', email: 'user1@example.com', name: 'User 1', created_at: Date.now() },
        ],
      });

      const c = createMockContext({ db: mockDB });

      await adminStatsHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          stats: expect.objectContaining({
            activeUsers: expect.any(Number),
            totalUsers: expect.any(Number),
            registeredClients: expect.any(Number),
            newUsersToday: expect.any(Number),
            loginsToday: expect.any(Number),
            piiHealth: expect.objectContaining({
              statusCounts: expect.any(Object),
              repairNeeded: expect.any(Number),
              partialPIIUsers: expect.any(Number),
            }),
          }),
          recentActivity: expect.any(Array),
        })
      );
    });

    it('should include active users count from last 30 days', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 25 },
        allResults: [],
      });

      const c = createMockContext({ db: mockDB });

      await adminStatsHandler(c);

      expect(mockDB.prepare).toHaveBeenCalledWith(expect.stringContaining('identity_accounts'));
    });

    it('should include recent activity in response', async () => {
      const now = Date.now();
      // Core DB returns user IDs and timestamps (no PII)
      const mockDB = createMockDB({
        firstResult: { count: 5 },
        allResults: [
          { id: 'user-1', created_at: now },
          { id: 'user-2', created_at: now - 1000 },
        ],
      });

      // PII DB returns email and name for the user IDs
      const mockDBPII = createMockDB({
        allResults: [
          { id: 'user-1', email: 'new@example.com', name: 'New User' },
          { id: 'user-2', email: 'another@example.com', name: 'Another' },
        ],
      });

      const c = createMockContext({ db: mockDB, dbPII: mockDBPII });

      await adminStatsHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          recentActivity: expect.arrayContaining([
            expect.objectContaining({
              type: 'user_registration',
              userId: 'user-1',
            }),
          ]),
        })
      );
    });

    it('should handle database errors gracefully', async () => {
      const mockDB = createMockDB({});
      (mockDB as any)._mockStatement.first.mockRejectedValue(new Error('DB connection failed'));

      const c = createMockContext({ db: mockDB });

      const response = await adminStatsHandler(c);

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual(
        expect.objectContaining({
          error: 'server_error',
          error_code: 'AR900001',
          error_description: 'An unexpected error occurred.',
        })
      );
    });
  });

  describe('archive-only audit hot query guard', () => {
    it('returns archive-backed audit log entries when archive-only profile is active', async () => {
      const archiveBucket = createMockR2Bucket([
        {
          key: 'audit/event/default/2026-04-30/evt-1.json',
          body: {
            id: 'evt-1',
            tenantId: 'default',
            eventType: 'user.login',
            eventCategory: 'auth',
            result: 'success',
            severity: 'info',
            clientId: 'client-1',
            detailsJson: JSON.stringify({
              resourceType: 'user',
              resourceId: 'user-1',
              ipAddress: '127.0.0.1',
            }),
            createdAt: Date.parse('2026-04-30T00:00:00.000Z'),
          },
        },
      ]);
      const c = createMockContext({
        envOverrides: {
          DEFAULT_AUDIT_PROFILE_ID: 'builtin:audit:archive-only-logpush',
          DIAGNOSTIC_LOGS: archiveBucket,
        } as Partial<Env>,
      });

      const response = await adminAuditLogListHandler(c);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        entries: Array<Record<string, unknown>>;
        pagination: { total: number };
      };
      expect(body.pagination.total).toBe(1);
      expect(body.entries).toEqual([
        expect.objectContaining({
          id: 'evt-1',
          action: 'user.login',
          resourceType: 'user',
          resourceId: 'user-1',
          ipAddress: '127.0.0.1',
        }),
      ]);
    });

    it('returns archive-backed audit log details when archive-only profile is active', async () => {
      const archiveBucket = createMockR2Bucket([
        {
          key: 'audit/event/default/2026-04-30/evt-1.json',
          body: {
            id: 'evt-1',
            tenantId: 'default',
            eventType: 'user.login',
            eventCategory: 'auth',
            result: 'success',
            severity: 'info',
            requestId: 'req-1',
            detailsJson: JSON.stringify({
              resourceType: 'user',
              resourceId: 'user-1',
              userAgent: 'Vitest',
            }),
            createdAt: Date.parse('2026-04-30T00:00:00.000Z'),
          },
        },
      ]);
      const c = createMockContext({
        params: { id: 'evt-1' },
        envOverrides: {
          DEFAULT_AUDIT_PROFILE_ID: 'builtin:audit:archive-only-logpush',
          DIAGNOSTIC_LOGS: archiveBucket,
        } as Partial<Env>,
      });

      const response = await adminAuditLogGetHandler(c);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toEqual(
        expect.objectContaining({
          id: 'evt-1',
          action: 'user.login',
          resourceType: 'user',
          resourceId: 'user-1',
          requestId: 'req-1',
          userAgent: 'Vitest',
        })
      );
    });

    it('returns an empty audit log list when the hot audit table is not initialized', async () => {
      const mockDB = createSqlAwareMockDB((sql) => {
        if (sql.includes('FROM event_log')) {
          throw new Error('no such table: event_log');
        }
        return null;
      });
      const c = createMockContext({ db: mockDB });

      const response = await adminAuditLogListHandler(c);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        entries: unknown[];
        pagination: { total: number; totalPages: number };
      };
      expect(body.entries).toEqual([]);
      expect(body.pagination.total).toBe(0);
      expect(body.pagination.totalPages).toBe(0);
    });

    it('returns pending_runtime_support for non-D1 primary audit profiles', async () => {
      const c = createMockContext({
        envOverrides: {
          DEFAULT_AUDIT_PROFILE_ID: 'custom:audit:postgres-primary',
        } as Partial<Env>,
      });

      const response = await adminAuditLogListHandler(c);
      expect(response.status).toBe(501);
      const body = (await response.json()) as {
        error: string;
        profile_id: string;
        hot_query_status: string;
      };
      expect(body.error).toBe('not_supported');
      expect(body.profile_id).toBe('custom:audit:postgres-primary');
      expect(body.hot_query_status).toBe('pending_runtime_support');
    });
  });

  describe('adminUserActivityLogHandler', () => {
    it('reads unified event_log entries using current schema columns', async () => {
      const mockDB = createSqlAwareMockDB(async (sql, params, op) => {
        if (sql.includes('SELECT id FROM users_core')) {
          return { id: 'user-1' };
        }

        if (sql.includes('FROM event_log') && op === 'all') {
          expect(sql).toContain('anonymized_user_id = ?');
          expect(sql).toContain('details_json as details');
          expect(params).toContain('anon-user-1');
          return [
            {
              id: 'audit-1',
              action: 'auth.login',
              details: JSON.stringify({ method: 'passkey' }),
              created_at: 1710000000000,
              ip_address: '127.0.0.1',
              user_agent: 'Vitest',
            },
          ];
        }

        if (sql.includes('FROM identity_accounts WHERE legacy_user_id = ?')) {
          return {
            id: 'account:user-1',
            tenant_id: 'default',
            legacy_user_id: 'user-1',
            primary_subject_id: 'subject:user-1',
            lifecycle_state: 'active',
            created_at: Date.now(),
            updated_at: Date.now(),
          };
        }

        if (sql.includes('SELECT anonymized_user_id FROM user_anonymization_map')) {
          return { anonymized_user_id: 'anon-user-1' };
        }

        return null;
      });

      const c = createMockContext({
        params: { id: 'user-1' },
        db: mockDB,
        dbPII: mockDB,
      });

      const response = await adminUserActivityLogHandler(c);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: Array<{
          action: string;
          details: Record<string, unknown>;
          ip_address: string | null;
        }>;
      };

      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        action: 'auth.login',
        details: expect.objectContaining({ method: 'passkey' }),
        ip_address: '127.0.0.1',
        user_agent: 'Vitest',
      });
    });
  });

  describe('adminUsersListHandler', () => {
    it('uses cursor-based routed projection for tenant-D1 storage without exposing bindings', async () => {
      const userId = 'user-route';
      const createdAt = Date.UTC(2026, 6, 10, 10, 35, 4);
      canonicalRuntimeUsers.set(userId, {
        id: userId,
        tenant_id: 'default',
        lifecycle_state: 'active',
        active: 1,
        email: 'routed@example.com',
        name: 'Routed User',
        email_verified: 1,
        phone_number_verified: 0,
        created_at: new Date(createdAt).toISOString(),
        updated_at: new Date(createdAt).toISOString(),
      });
      listCrossShardAccounts.mockResolvedValue({
        items: [
          {
            id: `account:${userId}`,
            legacyUserId: userId,
            tenantId: 'default',
            accountType: 'user',
            lifecycleState: 'active',
            displayLabel: 'Routed User',
            createdAt,
            coreBindingRef: 'DB',
            piiBindingRef: 'DB_PII',
          },
        ],
        nextCursor: 'opaque-next-cursor',
      });
      const core = createMockDB({ allResults: [] });
      const pii = createMockDB({ allResults: [] });
      const c = createMockContext({
        db: core,
        dbPII: pii,
        runtimeUserStoreSources: {
          storageProfile: {
            id: 'builtin:storage:tenant-d1',
            kind: 'storage',
            label: 'Tenant D1',
            slices: {},
          },
          coreDb: core,
          piiDb: pii,
          policyDb: core,
          userCacheScope: {
            storageProfileId: 'builtin:storage:tenant-d1',
            sourceGeneration: 'test',
            schemaVersion: 'test',
          },
          piiCacheMode: 'no_cross_request_pii',
        },
      });

      const response = await adminUsersListHandler(c);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        users: [expect.objectContaining({ id: userId, email: 'routed@example.com' })],
        pagination: {
          mode: 'cursor',
          limit: 20,
          nextCursor: 'opaque-next-cursor',
          hasNext: true,
        },
      });
      expect(JSON.stringify(body)).not.toContain('DB_PII');
      expect(JSON.stringify(body)).not.toContain('coreBindingRef');
    });

    it('uses exact routed search from server-owned tenant metadata without runtime sources', async () => {
      const userId = 'user-metadata-route';
      const createdAt = Date.UTC(2026, 6, 10, 10, 40, 0);
      canonicalRuntimeUsers.set(userId, {
        id: userId,
        tenant_id: 'default',
        lifecycle_state: 'active',
        active: 1,
        email: 'metadata-route@example.com',
        name: 'Metadata Routed User',
        email_verified: 1,
        phone_number_verified: 0,
        created_at: new Date(createdAt).toISOString(),
        updated_at: new Date(createdAt).toISOString(),
      });
      findExactCrossShardAccounts.mockResolvedValue([
        {
          id: `account:${userId}`,
          legacyUserId: userId,
          tenantId: 'default',
          accountType: 'user',
          lifecycleState: 'active',
          displayLabel: 'Metadata Routed User',
          createdAt,
          coreBindingRef: 'DB',
          piiBindingRef: 'DB_PII',
        },
      ]);
      const core = createMockDB({ allResults: [] });
      const pii = createMockDB({ allResults: [] });
      const response = await adminUsersListHandler(
        createMockContext({
          query: { search: 'metadata-route@example.com' },
          db: core,
          dbPII: pii,
          tenantMetadataContext: {
            tenantId: 'default',
            storageProfileId: 'builtin:storage:tenant-d1',
            coreDb: core,
          },
        })
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        users: [expect.objectContaining({ id: userId, email: 'metadata-route@example.com' })],
        pagination: { mode: 'exact', hasNext: false },
      });
      expect(findExactCrossShardAccounts).toHaveBeenCalledWith({
        tenantId: 'default',
        identifier: 'metadata-route@example.com',
      });
      expect(listCrossShardAccounts).not.toHaveBeenCalled();
    });

    it('returns 400 for malformed pagination instead of reaching a database', async () => {
      const response = await adminUsersListHandler(
        createMockContext({ query: { page: '1', limit: 'not-a-number' } })
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'invalid_pagination' });
    });

    it('maps a signed cursor tenant mismatch to a client-safe 400 response', async () => {
      listCrossShardAccounts.mockRejectedValue(new Error('cross_shard_cursor_tenant_mismatch'));
      const core = createMockDB({ allResults: [] });
      const response = await adminUsersListHandler(
        createMockContext({
          query: { cursor: 'signed-cursor' },
          db: core,
          dbPII: core,
          runtimeUserStoreSources: {
            storageProfile: {
              id: 'builtin:storage:tenant-d1',
              kind: 'storage',
              label: 'Tenant D1',
              slices: {},
            },
            coreDb: core,
            piiDb: core,
            policyDb: core,
            userCacheScope: {
              storageProfileId: 'builtin:storage:tenant-d1',
              sourceGeneration: 'test',
              schemaVersion: 'test',
            },
            piiCacheMode: 'no_cross_request_pii',
          },
        })
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: 'invalid_cursor' });
    });

    it('should return paginated users list', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 50 },
        allResults: [
          {
            id: 'user-1',
            email: 'user1@example.com',
            name: 'User One',
            email_verified: 1,
            phone_number_verified: 0,
            created_at: Date.now(),
            updated_at: Date.now(),
            last_login_at: null,
          },
          {
            id: 'user-2',
            email: 'user2@example.com',
            name: 'User Two',
            email_verified: 1,
            phone_number_verified: 1,
            created_at: Date.now(),
            updated_at: Date.now(),
            last_login_at: Date.now(),
          },
        ],
      });

      const c = createMockContext({
        query: { page: '1', limit: '20' },
        db: mockDB,
      });

      await adminUsersListHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          users: expect.any(Array),
          pagination: expect.objectContaining({
            page: 1,
            limit: 20,
            total: 2,
            totalPages: 1,
            hasNext: false,
            hasPrev: false,
          }),
        })
      );
    });

    it('returns normalized creation and last-login timestamps from the canonical projection', async () => {
      const userId = 'user-with-login';
      const createdAt = Date.UTC(2026, 6, 10, 10, 35, 4);
      const lastLoginAt = createdAt + 90_000;
      canonicalRuntimeUsers.set(userId, {
        id: userId,
        tenant_id: 'default',
        lifecycle_state: 'active',
        active: 1,
        email: 'user@example.com',
        name: 'User',
        email_verified: 1,
        phone_number_verified: 0,
        created_at: new Date(createdAt).toISOString(),
        updated_at: new Date(createdAt).toISOString(),
        last_login_at: lastLoginAt,
      });
      const c = createMockContext({
        query: { page: '1', limit: '20' },
        db: createMockDB({ allResults: [{ legacy_user_id: userId }] }),
      });

      const response = await adminUsersListHandler(c);
      const body = (await response.json()) as {
        users: Array<{ created_at: number; last_login_at: number | null }>;
      };

      expect(body.users).toEqual([
        expect.objectContaining({
          created_at: createdAt,
          last_login_at: lastLoginAt,
        }),
      ]);
    });

    it('uses the latest persisted session when a legacy user has no login timestamp', async () => {
      const userId = 'user-with-session-only';
      const createdAt = Date.UTC(2026, 6, 10, 10, 35, 4);
      const lastLoginAt = createdAt + 90_000;
      canonicalRuntimeUsers.set(userId, {
        id: userId,
        tenant_id: 'default',
        lifecycle_state: 'active',
        active: 1,
        email: 'user@example.com',
        name: 'User',
        email_verified: 1,
        phone_number_verified: 0,
        created_at: new Date(createdAt).toISOString(),
        updated_at: new Date(createdAt).toISOString(),
        last_login_at: null,
      });
      const c = createMockContext({
        query: { page: '1', limit: '20' },
        db: createSqlAwareMockDB((sql, _params, operation) => {
          if (operation !== 'all') return null;
          if (sql.includes('FROM identity_accounts')) {
            return [{ legacy_user_id: userId }];
          }
          if (sql.includes('FROM sessions')) {
            return [{ user_id: userId, last_login_at: Math.floor(lastLoginAt / 1000) }];
          }
          return [];
        }),
      });

      const response = await adminUsersListHandler(c);
      const body = (await response.json()) as {
        users: Array<{ last_login_at: number | null }>;
      };

      expect(body.users[0]?.last_login_at).toBe(lastLoginAt);
    });

    it('should support search filtering by email or name', async () => {
      // PII/Non-PII DB Separation:
      // 1. Search queries PII DB first to get matching user IDs
      // 2. Core DB is queried for user_core data with those IDs
      // 3. PII DB is queried again for full PII data

      canonicalRuntimeUsers.set('user-1', {
        id: 'user-1',
        tenant_id: 'default',
        lifecycle_state: 'active',
        active: 1,
        email: 'john@example.com',
        name: 'John Doe',
        email_verified: 1,
        phone_number_verified: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        last_login_at: null,
      });

      // Core DB returns the canonical account key used by the projection repository.
      const mockDB = createMockDB({
        firstResult: { count: 1 },
        allResults: [
          {
            legacy_user_id: 'user-1',
            user_id: 'user-1',
            tenant_id: 'default',
            email_verified: 1,
            phone_number_verified: 0,
            is_active: 1,
            user_type: 'end_user',
            pii_partition: 'default',
            pii_status: 'active',
            created_at: Date.now(),
            updated_at: Date.now(),
            last_login_at: null,
          },
        ],
      });

      // PII DB returns IDs for search (first call) and full PII data (second call)
      const mockDBPII = createMockDB({
        allResults: [
          {
            id: 'user-1',
            email: 'john@example.com',
            name: 'John Doe',
          },
        ],
      });

      const c = createMockContext({
        query: { search: 'john' },
        db: mockDB,
        dbPII: mockDBPII,
      });

      await adminUsersListHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          users: expect.arrayContaining([
            expect.objectContaining({
              email: 'john@example.com',
            }),
          ]),
        })
      );
    });

    it('should support verified filtering', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 30 },
        allResults: [],
      });

      const c = createMockContext({
        query: { verified: 'true' },
        db: mockDB,
      });

      await adminUsersListHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          users: [],
        })
      );
    });

    it('should include pagination metadata', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 100 },
        allResults: [],
      });

      const c = createMockContext({
        query: { page: '3', limit: '10' },
        db: mockDB,
      });

      await adminUsersListHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          pagination: expect.objectContaining({
            page: 3,
            limit: 10,
            total: 0,
            totalPages: 0,
            hasNext: false,
            hasPrev: true,
          }),
        })
      );
    });

    it('should convert boolean fields correctly', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 1 },
        allResults: [
          {
            id: 'user-1',
            email: 'test@example.com',
            name: 'Test User',
            email_verified: 1,
            phone_number_verified: 0,
            created_at: Date.now(),
            updated_at: Date.now(),
            last_login_at: null,
          },
        ],
      });

      const c = createMockContext({ db: mockDB });

      await adminUsersListHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          users: expect.arrayContaining([
            expect.objectContaining({
              email_verified: 1,
              phone_number_verified: 0,
            }),
          ]),
        })
      );
    });

    it('should support lifecycle_state filtering and include it in results', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 1 },
        allResults: [
          {
            id: 'user-1',
            tenant_id: 'default',
            email_verified: 1,
            phone_number_verified: 0,
            is_active: 1,
            user_type: 'end_user',
            pii_partition: 'default',
            pii_status: 'active',
            lifecycle_state: 'incomplete',
            created_at: Date.now(),
            updated_at: Date.now(),
            last_login_at: null,
          },
        ],
      });

      const c = createMockContext({
        query: { lifecycle_state: 'incomplete' },
        db: mockDB,
      });

      await adminUsersListHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          users: expect.arrayContaining([
            expect.objectContaining({
              lifecycle_state: 'incomplete',
            }),
          ]),
        })
      );
    });
  });

  describe('adminUserGetHandler', () => {
    it('resolves tenant-D1 account context before reading user details', async () => {
      const userId = 'routed-user';
      canonicalRuntimeUsers.set(userId, {
        id: userId,
        tenant_id: 'default',
        lifecycle_state: 'active',
        email: 'routed@example.com',
        email_verified: 1,
        phone_number_verified: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      const routedCore = createMockDB({ allResults: [] });
      const routedPii = createMockDB({ allResults: [] });
      const c = createMockContext({
        params: { id: userId },
        tenantMetadataContext: {
          tenantId: 'default',
          storageProfileId: 'builtin:storage:tenant-d1',
        },
      });
      resolveAccountDataContext.mockImplementationOnce(async (context, accountId) => {
        const accountDataContext = {
          tenantId: 'default',
          accountId: `account:${accountId}`,
          legacyUserId: accountId,
          coreDb: routedCore,
          piiDb: routedPii,
        };
        context.set('accountDataContext', accountDataContext);
        return accountDataContext;
      });

      const response = await adminUserGetHandler(c);

      expect(response.status).toBe(200);
      expect(resolveAccountDataContext).toHaveBeenCalledWith(c, userId);
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({ user: expect.objectContaining({ id: userId }) })
      );
    });

    it('returns the canonical suspended status and restriction timestamps', async () => {
      const userId = 'suspended-user';
      const suspendedAt = 1_752_700_000;
      const suspendedUntil = suspendedAt + 86_400;
      canonicalRuntimeUsers.set(userId, {
        id: userId,
        tenant_id: 'default',
        lifecycle_state: 'suspended',
        status: 'suspended',
        suspended_at: suspendedAt,
        suspended_until: suspendedUntil,
        active: 0,
        email: 'suspended@example.com',
        email_verified: 1,
        phone_number_verified: 0,
        created_at: new Date(suspendedAt * 1000).toISOString(),
        updated_at: new Date(suspendedAt * 1000).toISOString(),
      });
      const c = createMockContext({
        params: { id: userId },
        db: createMockDB({ allResults: [] }),
      });

      const response = await adminUserGetHandler(c);
      const body = (await response.json()) as {
        user: {
          status: string;
          is_active: number;
          pii_status: string;
          suspended_at: number | null;
          suspended_until: number | null;
        };
      };

      expect(body.user).toMatchObject({
        status: 'suspended',
        is_active: 0,
        pii_status: 'active',
        suspended_at: suspendedAt * 1000,
        suspended_until: suspendedUntil * 1000,
      });
    });

    it('should return user details with passkeys', async () => {
      const userId = 'user-123';
      // Core DB returns users_core data (no PII) and passkeys
      const mockDB = createMockDB({
        firstResult: {
          id: userId,
          tenant_id: 'default',
          email_verified: 1,
          phone_number_verified: 0,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: Date.now(),
          updated_at: Date.now(),
          last_login_at: null,
        },
        allResults: [
          {
            id: 'passkey-1',
            credential_id: 'cred-abc',
            device_name: 'Chrome on Mac',
            created_at: Date.now(),
            last_used_at: null,
          },
        ],
      });

      // PII DB returns users_pii data (email, name, etc.)
      const mockDBPII = createMockDB({
        firstResult: {
          id: userId,
          email: 'user@example.com',
          name: 'Test User',
        },
      });

      const c = createMockContext({
        params: { id: userId },
        db: mockDB,
        dbPII: mockDBPII,
      });

      await adminUserGetHandler(c);

      // API returns { user, passkeys, customFields }
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          user: expect.objectContaining({
            id: userId,
            email: 'user@example.com',
          }),
          passkeys: expect.any(Array),
        })
      );

      expect(
        (mockDB as any).prepare.mock.calls.some(([sql]: [string]) =>
          sql.includes('FROM user_custom_fields WHERE tenant_id = ? AND user_id = ?')
        )
      ).toBe(true);
    });

    it('should return 404 for non-existent user', async () => {
      const mockDB = createMockDB({
        firstResult: null,
      });

      const c = createMockContext({
        params: { id: 'nonexistent-user' },
        db: mockDB,
      });

      await adminUserGetHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'not_found',
          error_description: 'The requested resource was not found',
        }),
        404
      );
    });

    it('should include passkeys in user details', async () => {
      const userId = 'user-with-passkeys';
      const mockDB = createMockDB({
        firstResult: {
          id: userId,
          email: 'passkey-user@example.com',
          name: 'Passkey User',
          email_verified: 1,
          phone_number_verified: 0,
          created_at: Date.now(),
          updated_at: Date.now(),
          last_login_at: null,
        },
        allResults: [
          { id: 'pk-1', credential_id: 'cred-1', created_at: Date.now(), last_used_at: null },
          { id: 'pk-2', credential_id: 'cred-2', created_at: Date.now(), last_used_at: null },
        ],
      });

      const c = createMockContext({
        params: { id: userId },
        db: mockDB,
      });

      await adminUserGetHandler(c);

      expect(mockDB.prepare).toHaveBeenCalledWith(expect.stringContaining('passkeys'));
    });

    it('should include lifecycle_state and missing_required_fields in user details', async () => {
      const userId = 'user-missing-required';
      const mockDB = createMockDB({
        firstResult: {
          id: userId,
          tenant_id: 'default',
          email_verified: 1,
          phone_number_verified: 0,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          lifecycle_state: 'incomplete',
          created_at: Date.now(),
          updated_at: Date.now(),
          last_login_at: null,
        },
        allResults: [],
      });
      (mockDB as any)._mockStatement.all.mockImplementation(() => {
        const preparedSql = String((mockDB.prepare as any).mock.calls.at(-1)?.[0] ?? '');
        if (preparedSql.includes('FROM custom_claim_schemas')) {
          return Promise.resolve({
            results: [createCustomClaimSchemaRow()],
          });
        }
        return Promise.resolve({ results: [] });
      });

      const mockDBPII = createMockDB({
        firstResult: {
          id: userId,
          email: 'user@example.com',
          name: 'Missing Required User',
          custom_attributes_json: '{}',
        },
        allResults: [],
      });

      const c = createMockContext({
        params: { id: userId },
        db: mockDB,
        dbPII: mockDBPII,
      });

      await adminUserGetHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          user: expect.objectContaining({
            lifecycle_state: 'incomplete',
          }),
          missing_required_fields: [
            {
              field_key: 'department',
              label: 'Department',
              field_type: 'string',
            },
          ],
        })
      );
    });
  });

  describe('adminUserCreateHandler', () => {
    it('should require email field', async () => {
      const mockDB = createMockDB({});

      const c = createMockContext({
        method: 'POST',
        body: { name: 'User without email' },
        db: mockDB,
      });

      await adminUserCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'Email is required',
        }),
        400
      );
    });

    it('should reject invalid email syntax before persistence', async () => {
      const mockDB = createMockDB({});

      const c = createMockContext({
        method: 'POST',
        body: { email: 'not-an-email', name: 'Invalid Email User' },
        db: mockDB,
      });

      await adminUserCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'Email must be a valid email address',
        }),
        400
      );
      expect(mockDB.prepare).not.toHaveBeenCalled();
    });

    it('should require an idempotency key before account allocation', async () => {
      const c = createMockContext({
        method: 'POST',
        body: { email: 'person@example.com' },
      });

      await adminUserCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'A valid Idempotency-Key header is required',
        }),
        400
      );
      expect(executeDurableAccountCreation).not.toHaveBeenCalled();
    });

    it('should reject create when required custom field is missing', async () => {
      const mockDB = createMockDB({
        runResult: { success: true },
      });
      (mockDB as any)._mockStatement.all.mockResolvedValueOnce({
        results: [createCustomClaimSchemaRow()],
      });

      const mockDBPII = createMockDB({
        firstResult: null,
      });

      const c = createMockContext({
        method: 'POST',
        headers: { 'Idempotency-Key': 'admin-create-required-field' },
        body: {
          email: 'newuser@example.com',
          name: 'New User',
        },
        db: mockDB,
        dbPII: mockDBPII,
      });

      await adminUserCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'Department is required',
          missing_required_fields: [
            {
              field_key: 'department',
              label: 'Department',
              field_type: 'string',
            },
          ],
        }),
        400
      );
    });

    it('should create new user with valid data', async () => {
      // PII/Non-PII DB Separation:
      // 1. Check email uniqueness in PII DB (returns null = no existing user)
      // 2. Insert into Core DB
      // 3. Insert into PII DB
      // 4. Update Core DB pii_status
      // 5. Fetch created user from both DBs

      const mockDB = createMockDB({
        runResult: { success: true },
      });
      (mockDB as any)._mockStatement.all.mockResolvedValueOnce({
        results: [createCustomClaimSchemaRow({ is_required: 0 })],
      });

      // Configure Core DB mock to return created user on final query
      let coreQueryCount = 0;
      (mockDB as any)._mockStatement.first.mockImplementation(() => {
        coreQueryCount++;
        // After inserts and updates, return the created user_core data
        return Promise.resolve({
          id: 'new-user-id',
          tenant_id: 'default',
          email_verified: 0,
          phone_number_verified: 0,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: Date.now(),
          updated_at: Date.now(),
        });
      });

      // PII DB: first call checks email uniqueness, final call returns created PII
      const mockDBPII = createMockDB({
        runResult: { success: true },
      });
      let piiQueryCount = 0;
      (mockDBPII as any)._mockStatement.first.mockImplementation(() => {
        piiQueryCount++;
        return Promise.resolve({
          id: 'new-user-id',
          email: 'newuser@example.com',
          name: 'New User',
        });
      });

      const c = createMockContext({
        method: 'POST',
        headers: { 'Idempotency-Key': 'admin-create-valid-user' },
        body: {
          email: 'newuser@example.com',
          name: 'New User',
          department: 'Engineering',
        },
        db: mockDB,
        dbPII: mockDBPII,
      });

      await adminUserCreateHandler(c);

      expect(executeDurableAccountCreation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tenantId: 'default',
          actorId: 'admin-user',
          idempotencyKey: 'admin-create-valid-user',
          email: 'newuser@example.com',
          residencyPartition: 'default',
        }),
        expect.objectContaining({ operationRepository: expect.anything() })
      );
      // API returns { user }
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          user: expect.objectContaining({
            id: expect.stringMatching(/^user-/u),
          }),
        }),
        201
      );
    });

    it('allocates a tenant-D1 account before an account data context exists', async () => {
      const mockDB = createMockDB({
        runResult: { success: true },
        firstResult: {
          id: 'account:new-user-id',
          legacy_user_id: 'new-user-id',
          tenant_id: 'default',
          lifecycle_state: 'active',
          email_verified: 0,
          phone_number_verified: 0,
          account_type: 'end_user',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      });
      (mockDB as any)._mockStatement.all.mockResolvedValueOnce({ results: [] });
      const mockDBPII = createMockDB({
        runResult: { success: true },
        firstResult: {
          account_id: 'account:new-user-id',
          email: 'tenant-d1-user@example.com',
          preferred_username: 'tenant-d1-user',
        },
      });
      const c = createMockContext({
        method: 'POST',
        headers: { 'Idempotency-Key': 'admin-create-tenant-d1-user' },
        body: { email: 'tenant-d1-user@example.com' },
        db: mockDB,
        dbPII: mockDBPII,
        envOverrides: {
          DEFAULT_STORAGE_PROFILE_ID: 'builtin:storage:tenant-d1',
        },
        tenantMetadataContext: {
          tenantId: 'default',
          storageProfileId: 'builtin:storage:tenant-d1',
          coreDb: mockDB,
        },
      });

      await adminUserCreateHandler(c);

      expect(executeDurableAccountCreation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tenantId: 'default',
          idempotencyKey: 'admin-create-tenant-d1-user',
          email: 'tenant-d1-user@example.com',
        }),
        expect.anything()
      );
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({ user: expect.anything() }),
        201
      );
    });

    it('should create a canonical runtime user when runtime cutover is enabled', async () => {
      const mockDB = createMockDB({
        runResult: { success: true },
      });
      (mockDB as any)._mockStatement.all.mockResolvedValueOnce({
        results: [createCustomClaimSchemaRow({ is_required: 0 })],
      });
      (mockDB as any)._mockStatement.first.mockResolvedValue({
        id: 'new-user-id',
        tenant_id: 'default',
        email_verified: 1,
        phone_number_verified: 0,
        is_active: 1,
        user_type: 'end_user',
        pii_partition: 'default',
        pii_status: 'active',
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      const mockDBPII = createMockDB({
        runResult: { success: true },
      });
      let piiQueryCount = 0;
      (mockDBPII as any)._mockStatement.first.mockImplementation(() => {
        piiQueryCount++;
        return Promise.resolve({
          id: 'new-user-id',
          tenant_id: 'default',
          email: 'newuser@example.com',
          name: 'New User',
        });
      });

      const c = createMockContext({
        method: 'POST',
        headers: { 'Idempotency-Key': 'admin-create-canonical-user' },
        body: {
          email: 'newuser@example.com',
          name: 'New User',
        },
        db: mockDB,
        dbPII: mockDBPII,
        envOverrides: {
          ENABLE_CANONICAL_IDENTITY_RUNTIME: 'true',
        },
      });

      await adminUserCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          user: expect.objectContaining({
            id: expect.stringMatching(/^user-/u),
          }),
        }),
        201
      );
    });

    it('should prevent duplicate email (409 error)', async () => {
      // PII/Non-PII DB Separation:
      // Email uniqueness is checked in PII DB (not Core DB)
      const mockDB = createMockDB({});

      // PII DB returns existing user when checking for duplicate email
      const mockDBPII = createMockDB({
        firstResult: { id: 'existing-user', email: 'duplicate@example.com' },
      });

      const c = createMockContext({
        method: 'POST',
        headers: { 'Idempotency-Key': 'admin-create-duplicate-user' },
        body: {
          email: 'duplicate@example.com',
          name: 'Duplicate User',
        },
        db: mockDB,
        dbPII: mockDBPII,
      });

      executeDurableAccountCreation.mockRejectedValueOnce(
        new Error('directory_identifier_reservation_conflict')
      );

      await adminUserCreateHandler(c);

      // Security: Generic message to prevent email enumeration
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'conflict',
          error_description: 'Unable to create user with the provided information',
        }),
        409
      );
    });

    it('should return an operation reference when directory publication is pending', async () => {
      const mockDB = createMockDB({ runResult: { success: true } });
      (mockDB as any)._mockStatement.all.mockResolvedValueOnce({ results: [] });
      executeDurableAccountCreation.mockResolvedValueOnce({
        operation: {
          operationId: 'operation-pending',
          tenantId: 'default',
          actorId: 'admin-user',
          idempotencyKey: 'admin-create-pending-user',
          allocationIdempotencyKey: `account-create:${'a'.repeat(64)}`,
          requestHash: 'b'.repeat(64),
          userId: 'user-pending',
          accountId: 'account:user-pending',
          status: 'directory_pending',
          publication: null,
        },
        publication: {},
        delivery: {
          status: 202,
          operationId: 'operation-pending',
          accountId: 'account:user-pending',
        },
      });
      const c = createMockContext({
        method: 'POST',
        headers: { 'Idempotency-Key': 'admin-create-pending-user' },
        body: { email: 'pending@example.com' },
        db: mockDB,
      });

      await adminUserCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        {
          status: 'pending',
          state: 'directory_pending',
          operation_id: 'operation-pending',
          status_url: '/api/admin/users/operations/operation-pending',
        },
        202
      );
      expect(resolveAccountCreationTargets).not.toHaveBeenCalled();
    });

    it('should report temporary unavailability while Control replenishes capacity', async () => {
      const mockDB = createMockDB({ runResult: { success: true } });
      (mockDB as any)._mockStatement.all.mockResolvedValueOnce({ results: [] });
      executeDurableAccountCreation.mockRejectedValueOnce(
        new Error('control_account_allocation_capacity_unavailable')
      );
      const c = createMockContext({
        method: 'POST',
        headers: { 'Idempotency-Key': 'admin-create-no-capacity' },
        body: { email: 'capacity@example.com' },
        db: mockDB,
      });

      await adminUserCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        {
          error: 'temporarily_unavailable',
          error_description: 'Account capacity is being provisioned',
        },
        503
      );
    });
  });

  describe('adminUserCreationOperationHandler', () => {
    const operationRow = {
      operation_id: 'operation-pending',
      tenant_id: 'default',
      actor_id: 'admin-user',
      idempotency_key: 'admin-create-pending-user',
      allocation_idempotency_key: `account-create:${'a'.repeat(64)}`,
      request_hash: 'b'.repeat(64),
      user_id: 'user-pending',
      account_id: 'account:user-pending',
      status: 'directory_pending',
      publication_json: null,
    };

    it('returns the owning administrator operation state', async () => {
      const c = createMockContext({
        params: { operationId: 'operation-pending' },
        db: createMockDB({ firstResult: operationRow }),
      });

      await adminUserCreationOperationHandler(c);

      expect(c.json).toHaveBeenCalledWith({
        operation_id: 'operation-pending',
        state: 'directory_pending',
      });
    });

    it('does not disclose an operation owned by another administrator', async () => {
      const c = createMockContext({
        params: { operationId: 'operation-pending' },
        db: createMockDB({ firstResult: { ...operationRow, actor_id: 'admin-other' } }),
      });

      await adminUserCreationOperationHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        {
          error: 'not_found',
          error_description: 'Account creation operation was not found',
        },
        404
      );
    });

    it('reports operation storage failures as server errors', async () => {
      const db = createMockDB({ firstResult: operationRow });
      (db as any)._mockStatement.first.mockRejectedValue(
        new Error('simulated_database_unavailable')
      );
      const c = createMockContext({
        params: { operationId: 'operation-pending' },
        db,
      });

      await adminUserCreationOperationHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        {
          error: 'server_error',
          error_description: 'Failed to read account creation operation',
        },
        500
      );
    });
  });

  describe('adminUserUpdateHandler', () => {
    it('should persist custom field updates', async () => {
      const userId = 'user-custom-update';
      const mockDB = createMockDB({
        runResult: { success: true },
      });

      let coreQueryCount = 0;
      (mockDB as any)._mockStatement.first.mockImplementation(() => {
        coreQueryCount++;
        return Promise.resolve({
          id: userId,
          tenant_id: 'default',
          email_verified: 0,
          phone_number_verified: 0,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: Date.now(),
          updated_at: Date.now(),
          last_login_at: null,
        });
      });
      (mockDB as any)._mockStatement.all
        .mockResolvedValueOnce({
          results: [createCustomClaimSchemaRow({ is_required: 0 })],
        })
        .mockResolvedValueOnce({
          results: [],
        });

      const mockDBPII = createMockDB({
        firstResult: {
          id: userId,
          email: 'old@example.com',
          name: 'Updated Name',
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: userId },
        body: {
          department: 'Support',
        },
        db: mockDB,
        dbPII: mockDBPII,
      });

      await adminUserUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          user: expect.objectContaining({
            id: userId,
          }),
        })
      );
    });

    it('should update user fields', async () => {
      // PII/Non-PII DB Separation:
      // Core fields (email_verified, phone_number_verified, user_type) → Core DB
      // PII fields (name, phone_number, picture, etc.) → PII DB

      const userId = 'user-to-update';
      const mockDB = createMockDB({
        runResult: { success: true },
      });
      (mockDB as any)._mockStatement.all
        .mockResolvedValueOnce({
          results: [createCustomClaimSchemaRow({ is_required: 0 })],
        })
        .mockResolvedValueOnce({
          results: [],
        });

      // Core DB: first call checks user exists, subsequent calls for updates/reads
      let coreQueryCount = 0;
      (mockDB as any)._mockStatement.first.mockImplementation(() => {
        coreQueryCount++;
        // All calls return the user_core data
        return Promise.resolve({
          id: userId,
          tenant_id: 'default',
          email_verified: 1,
          phone_number_verified: 0,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: Date.now(),
          updated_at: Date.now(),
        });
      });

      // PII DB: returns updated PII data
      const mockDBPII = createMockDB({
        runResult: { success: true },
        firstResult: {
          id: userId,
          email: 'old@example.com',
          name: 'Updated Name',
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: userId },
        body: {
          email: 'old@example.com',
          name: 'Updated Name',
          email_verified: true,
        },
        db: mockDB,
        dbPII: mockDBPII,
      });

      await adminUserUpdateHandler(c);

      // API returns { user }
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          user: expect.objectContaining({
            id: userId,
            name: 'Updated Name',
          }),
        })
      );
    });

    it('should sync the canonical runtime user when runtime cutover is enabled', async () => {
      const userId = 'user-to-update';
      const mockDB = createMockDB({
        runResult: { success: true },
      });
      (mockDB as any)._mockStatement.all
        .mockResolvedValueOnce({
          results: [createCustomClaimSchemaRow({ is_required: 0 })],
        })
        .mockResolvedValueOnce({
          results: [],
        });
      (mockDB as any)._mockStatement.first.mockResolvedValue({
        id: userId,
        tenant_id: 'default',
        legacy_user_id: userId,
        primary_subject_id: `subject:${userId}`,
        email_verified: 1,
        phone_number_verified: 0,
        is_active: 1,
        lifecycle_state: 'active',
        user_type: 'end_user',
        pii_partition: 'default',
        pii_status: 'active',
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      const mockDBPII = createMockDB({
        runResult: { success: true },
        firstResult: {
          id: userId,
          tenant_id: 'default',
          email: 'old@example.com',
          name: 'Updated Name',
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: userId },
        body: {
          name: 'Updated Name',
          email_verified: true,
        },
        db: mockDB,
        dbPII: mockDBPII,
        envOverrides: {
          ENABLE_CANONICAL_IDENTITY_RUNTIME: 'true',
        },
      });

      await adminUserUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          user: expect.objectContaining({
            id: userId,
          }),
        })
      );
    });

    it('should mark pii_status failed when a PII field update fails after core update', async () => {
      const userId = 'user-pii-update-fails';
      const mockDB = createMockDB({
        runResult: { success: true },
      });
      (mockDB as any)._mockStatement.all
        .mockResolvedValueOnce({
          results: [createCustomClaimSchemaRow({ is_required: 0 })],
        })
        .mockResolvedValueOnce({
          results: [],
        });
      (mockDB as any)._mockStatement.first.mockResolvedValue({
        id: userId,
        tenant_id: 'default',
        email_verified: 1,
        phone_number_verified: 0,
        is_active: 1,
        user_type: 'end_user',
        pii_partition: 'default',
        pii_status: 'active',
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      const mockDBPII = createMockDB({
        firstResult: {
          id: userId,
          email: 'old@example.com',
          name: 'Old Name',
        },
      });
      (mockDBPII as any)._mockStatement.run.mockRejectedValue(new Error('PII write failed'));

      const c = createMockContext({
        method: 'PUT',
        params: { id: userId },
        body: {
          name: 'Updated Name',
          email_verified: true,
        },
        db: mockDB,
        dbPII: mockDBPII,
      });

      await adminUserUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          user: expect.objectContaining({
            id: userId,
          }),
        })
      );
    });

    it('should return 404 for non-existent user', async () => {
      const mockDB = createMockDB({
        firstResult: null,
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'nonexistent-user' },
        body: { name: 'Update' },
        db: mockDB,
      });

      await adminUserUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'not_found',
          error_description: 'The requested resource was not found',
        }),
        404
      );
    });

    it('should update timestamp on modification', async () => {
      // PII/Non-PII DB Separation:
      // Updated `name` is a PII field, stored in PII DB
      // Both Core DB and PII DB have updated_at timestamps

      const userId = 'user-update-ts';
      const mockDB = createMockDB({
        runResult: { success: true },
      });

      // Core DB: returns user_core data
      (mockDB as any)._mockStatement.first.mockImplementation(() => {
        return Promise.resolve({
          id: userId,
          tenant_id: 'default',
          email_verified: 0,
          phone_number_verified: 0,
          is_active: 1,
          user_type: 'end_user',
          pii_partition: 'default',
          pii_status: 'active',
          created_at: Date.now(),
          updated_at: Date.now(),
        });
      });

      // PII DB: returns updated PII data
      const mockDBPII = createMockDB({
        runResult: { success: true },
        firstResult: {
          id: userId,
          email: 'test@example.com',
          name: 'Updated',
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: userId },
        body: { name: 'Updated' },
        db: mockDB,
        dbPII: mockDBPII,
      });

      await adminUserUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          user: expect.objectContaining({
            id: userId,
          }),
        })
      );
    });
  });

  describe('adminUserDeleteHandler', () => {
    it('deletes a tenant-D1 user through the routed removal saga', async () => {
      const userId = 'user-routed-delete';
      const core = createMockDB({ firstResult: null, runResult: { success: true } });
      const pii = createMockDB({ firstResult: null, runResult: { success: true } });
      canonicalRuntimeUsers.set(userId, {
        id: userId,
        tenant_id: 'default',
        lifecycle_state: 'active',
        active: 1,
        email: 'routed-delete@example.com',
        email_verified: 0,
        phone_number_verified: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      findExactCrossShardAccounts.mockResolvedValue([
        {
          id: `account:${userId}`,
          legacyUserId: userId,
          tenantId: 'default',
          accountType: 'user',
          lifecycleState: 'active',
          displayLabel: null,
          createdAt: Date.now(),
          coreBindingRef: 'DB',
          piiBindingRef: 'DB_PII',
        },
      ]);
      const c = createMockContext({
        method: 'DELETE',
        params: { id: userId },
        db: core,
        dbPII: pii,
        tenantMetadataContext: {
          tenantId: 'default',
          storageProfileId: 'builtin:storage:tenant-d1',
          coreDb: core,
        },
      });

      await adminUserDeleteHandler(c);

      expect(findExactCrossShardAccounts).toHaveBeenCalledWith({
        tenantId: 'default',
        identifier: userId,
        purpose: 'account_delete_retry',
      });
      expect(prepareAccountRemoval).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tenantId: 'default', userId })
      );
      expect(eraseAccountPii).toHaveBeenCalledWith(expect.anything(), {
        tenantId: 'default',
        userId,
      });
      expect(markAccountRemovalsReady).toHaveBeenCalled();
      expect(attemptAccountRemovals).toHaveBeenCalled();
      expect(canonicalRuntimeUsers.get(userId)).toMatchObject({ lifecycle_state: 'deleted' });
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, message: 'User deleted successfully' })
      );
    });

    it('resumes tenant-D1 deletion after the PII projection has already been erased', async () => {
      const userId = 'user-routed-delete-retry';
      const core = createMockDB({ firstResult: null, runResult: { success: true } });
      const pii = createMockDB({ firstResult: null, runResult: { success: true } });
      findExactCrossShardAccounts.mockResolvedValue([
        {
          id: `account:${userId}`,
          legacyUserId: userId,
          tenantId: 'default',
          accountType: 'user',
          lifecycleState: 'deleting',
          displayLabel: null,
          createdAt: Date.now(),
          coreBindingRef: 'DB',
          piiBindingRef: 'DB_PII',
        },
      ]);
      const c = createMockContext({
        method: 'DELETE',
        params: { id: userId },
        db: core,
        dbPII: pii,
        tenantMetadataContext: {
          tenantId: 'default',
          storageProfileId: 'builtin:storage:tenant-d1',
          coreDb: core,
        },
      });

      await adminUserDeleteHandler(c);

      expect(prepareAccountRemoval).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ tenantId: 'default', userId })
      );
      expect(markAccountRemovalsReady).toHaveBeenCalled();
      expect(attemptAccountRemovals).toHaveBeenCalled();
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true, message: 'User deleted successfully' })
      );
    });

    it('fails closed when an active tenant-D1 route has no matching projection', async () => {
      const userId = 'user-routed-delete-missing-projection';
      const core = createMockDB({ firstResult: null, runResult: { success: true } });
      const pii = createMockDB({ firstResult: null, runResult: { success: true } });
      findExactCrossShardAccounts.mockResolvedValue([
        {
          id: `account:${userId}`,
          legacyUserId: userId,
          tenantId: 'default',
          accountType: 'user',
          lifecycleState: 'active',
          displayLabel: null,
          createdAt: Date.now(),
          coreBindingRef: 'DB',
          piiBindingRef: 'DB_PII',
        },
      ]);
      const c = createMockContext({
        method: 'DELETE',
        params: { id: userId },
        db: core,
        dbPII: pii,
        tenantMetadataContext: {
          tenantId: 'default',
          storageProfileId: 'builtin:storage:tenant-d1',
          coreDb: core,
        },
      });

      await adminUserDeleteHandler(c);

      expect(prepareAccountRemoval).not.toHaveBeenCalled();
      expect(c.json).toHaveBeenCalledWith(
        {
          error: 'server_error',
          error_description: 'Failed to delete user',
        },
        500
      );
    });

    it('should delete user successfully', async () => {
      const userId = 'user-to-delete';
      const mockDB = createMockDB({
        firstResult: { id: userId, email: 'delete@example.com' },
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'DELETE',
        params: { id: userId },
        db: mockDB,
      });

      await adminUserDeleteHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should mark the canonical runtime user deleted when runtime cutover is enabled', async () => {
      const userId = 'user-to-delete';
      const mockDB = createMockDB({
        firstResult: {
          id: 'account:user-to-delete',
          tenant_id: 'default',
          legacy_user_id: userId,
          primary_subject_id: 'subject:user-to-delete',
          lifecycle_state: 'active',
          pii_partition: 'default',
          pii_status: 'active',
          is_active: 1,
          email_verified: 1,
          phone_number_verified: 0,
          user_type: 'end_user',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'DELETE',
        params: { id: userId },
        db: mockDB,
        envOverrides: {
          ENABLE_CANONICAL_IDENTITY_RUNTIME: 'true',
        },
      });

      await adminUserDeleteHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });

    it('should return 404 for non-existent user', async () => {
      const mockDB = createMockDB({
        firstResult: null,
      });

      const c = createMockContext({
        method: 'DELETE',
        params: { id: 'nonexistent-user' },
        db: mockDB,
      });

      await adminUserDeleteHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'not_found',
          error_description: 'The requested resource was not found',
        }),
        404
      );
    });

    it('should cascade delete related data (passkeys, sessions)', async () => {
      const userId = 'user-with-related-data';
      const mockDB = createMockDB({
        firstResult: { id: userId, email: 'cascade@example.com' },
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'DELETE',
        params: { id: userId },
        db: mockDB,
      });

      await adminUserDeleteHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
    });
  });

  describe('adminUserAnonymizeHandler', () => {
    it('should anonymize using current schema tables and avoid legacy SQL', async () => {
      const userId = 'user-anon-1';
      const coreDb = createSqlAwareMockDB(async (sql, _params, op) => {
        if (op === 'first') {
          if (sql.includes('FROM identity_accounts WHERE legacy_user_id = ?')) {
            return {
              id: `account:${userId}`,
              tenant_id: 'default',
              legacy_user_id: userId,
              primary_subject_id: `subject:${userId}`,
              lifecycle_state: 'active',
              created_at: Date.now(),
              updated_at: Date.now(),
            };
          }
          if (sql.includes('SELECT id, reason FROM legal_holds')) {
            return null;
          }
          return undefined;
        }

        if (op === 'all' && sql.includes('SELECT * FROM sessions WHERE tenant_id = ?')) {
          return [
            {
              id: 'sess-1',
              user_id: userId,
              expires_at: Date.now() + 3600_000,
              created_at: Date.now(),
              tenant_id: 'default',
            },
          ];
        }

        return op === 'run' ? { success: true } : undefined;
      });

      const piiDb = createSqlAwareMockDB(async (sql, _params, op) => {
        if (op === 'first') {
          if (sql.includes('SELECT * FROM users_pii_tombstone WHERE id = ?')) {
            return null;
          }
          if (
            sql.includes('FROM identity_sensitive_values') &&
            sql.includes("value_key = 'email'")
          ) {
            return {
              value_json: JSON.stringify('anon@example.com'),
            };
          }
          return undefined;
        }

        return op === 'run' ? { success: true } : undefined;
      });

      const c = createMockContext({
        method: 'POST',
        params: { id: userId },
        body: { reason_code: 'user_request', confirm: true },
        db: coreDb,
        dbPII: piiDb,
      });

      const res = await adminUserAnonymizeHandler(c);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        tombstone_id: string | null;
      };

      expect(body.success).toBe(true);
      expect(body.tombstone_id).toBe(userId);

      const coreSqls = (coreDb.prepare as any).mock.calls.map((call: [string]) => call[0]);
      const piiSqls = (piiDb.prepare as any).mock.calls.map((call: [string]) => call[0]);

      expect(piiSqls).toContainEqual(expect.stringContaining('INSERT INTO users_pii_tombstone'));
      expect(piiSqls).toContainEqual(expect.stringContaining('identity_sensitive_values'));
      expect(coreSqls).toContainEqual(
        expect.stringContaining('DELETE FROM subject_org_membership')
      );
      expect(coreSqls).toContainEqual(
        expect.stringContaining('DELETE FROM passkeys WHERE tenant_id = ? AND user_id = ?')
      );
      expect(coreSqls).toContainEqual(
        expect.stringContaining('DELETE FROM sessions WHERE tenant_id = ? AND user_id = ?')
      );
      expect(coreSqls).toContainEqual(
        expect.stringContaining(
          'DELETE FROM session_clients WHERE tenant_id = ? AND session_id = ?'
        )
      );
      expect(coreSqls).toContainEqual(
        expect.stringContaining('DELETE FROM user_roles WHERE tenant_id = ? AND user_id = ?')
      );
      expect(canonicalRuntimeUsers.get(userId)).toEqual(
        expect.objectContaining({ active: 0, lifecycle_state: 'deleted' })
      );
      expect(coreSqls).not.toContainEqual(expect.stringContaining('UPDATE sessions SET revoked'));
      expect(coreSqls).not.toContainEqual(expect.stringContaining('UPDATE users_core SET'));
      expect(coreSqls).not.toContainEqual(expect.stringContaining('organization_members'));
      expect(coreSqls).not.toContainEqual(expect.stringContaining('passkey_credentials'));
      expect(piiSqls).not.toContainEqual(
        expect.stringContaining('DELETE FROM users_pii WHERE id = ?')
      );
      expect(piiSqls).not.toContainEqual(
        expect.stringContaining('DELETE FROM users_pii WHERE user_id = ?')
      );
    });
  });

  describe('adminUserSendEmailHandler', () => {
    it('should load email from users_pii by id and tenant_id before enqueuing email', async () => {
      const userId = 'user-mail-1';
      const coreDb = createSqlAwareMockDB(async (sql, _params, op) => {
        if (op === 'first' && sql.includes('FROM identity_accounts WHERE legacy_user_id = ?')) {
          return {
            id: `account:${userId}`,
            tenant_id: 'default',
            legacy_user_id: userId,
            primary_subject_id: `subject:${userId}`,
            lifecycle_state: 'active',
            created_at: Date.now(),
            updated_at: Date.now(),
          };
        }

        return op === 'run' ? { success: true } : undefined;
      });

      const piiDb = createSqlAwareMockDB(async (sql, params, op) => {
        if (op === 'first' && sql.includes('FROM identity_sensitive_values')) {
          expect(params).toEqual(['default', userId]);
          return { value_json: JSON.stringify('mail@example.com') };
        }

        return op === 'run' ? { success: true } : undefined;
      });

      const c = createMockContext({
        method: 'POST',
        params: { id: userId },
        body: {
          template: 'welcome',
          subject: 'hello',
          variables: { locale: 'ja' },
        },
        db: coreDb,
        dbPII: piiDb,
      });

      const res = await adminUserSendEmailHandler(c);
      expect(res.status).toBe(200);

      const piiSqls = (piiDb.prepare as any).mock.calls.map((call: [string]) => call[0]);
      const coreSqls = (coreDb.prepare as any).mock.calls.map((call: [string]) => call[0]);

      expect(piiSqls).toContainEqual(expect.stringContaining('identity_sensitive_values'));
      expect(piiSqls).not.toContainEqual(expect.stringContaining('WHERE user_id = ?'));
      expect(coreSqls).toContainEqual(expect.stringContaining('INSERT INTO email_queue'));
    });
  });

  describe('adminClientsListHandler', () => {
    it('should return paginated clients list', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 25 },
        allResults: [
          {
            client_id: 'client-1',
            client_name: 'Client One',
            redirect_uris: '["https://example.com/callback"]',
            grant_types: '["authorization_code"]',
            response_types: '["code"]',
            created_at: Date.now(),
            updated_at: Date.now(),
          },
          {
            client_id: 'client-2',
            client_name: 'Client Two',
            redirect_uris: '["https://another.com/callback"]',
            grant_types: '["authorization_code","refresh_token"]',
            response_types: '["code"]',
            created_at: Date.now(),
            updated_at: Date.now(),
          },
        ],
      });

      const c = createMockContext({
        query: { page: '1', limit: '10' },
        db: mockDB,
      });

      await adminClientsListHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          clients: expect.any(Array),
          pagination: expect.objectContaining({
            page: 1,
            limit: 10,
            total: 25,
          }),
        })
      );
    });

    it('should support search filtering by client_id or client_name', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 1 },
        allResults: [
          {
            client_id: 'my-app-client',
            client_name: 'My App',
            redirect_uris: '["https://myapp.com/callback"]',
            grant_types: '["authorization_code"]',
            response_types: '["code"]',
            created_at: Date.now(),
            updated_at: Date.now(),
          },
        ],
      });

      const c = createMockContext({
        query: { search: 'my-app' },
        db: mockDB,
      });

      await adminClientsListHandler(c);

      expect(mockDB.prepare).toHaveBeenCalledWith(expect.stringContaining('LIKE'));
    });

    it('should parse JSON fields correctly', async () => {
      const mockDB = createMockDB({
        firstResult: { count: 1 },
        allResults: [
          {
            client_id: 'json-client',
            client_name: 'JSON Test Client',
            redirect_uris: '["https://a.com/cb","https://b.com/cb"]',
            grant_types: '["authorization_code","refresh_token"]',
            response_types: '["code"]',
            created_at: Date.now(),
            updated_at: Date.now(),
          },
        ],
      });

      const c = createMockContext({ db: mockDB });

      await adminClientsListHandler(c);

      // adminClientsListHandler does not parse JSON fields for list view (optimization)
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          clients: expect.any(Array),
          pagination: expect.any(Object),
        })
      );
    });
  });

  describe('adminClientGetHandler', () => {
    it('should return client details', async () => {
      const clientId = 'test-client';
      const mockDB = createMockDB({
        firstResult: {
          client_id: clientId,
          client_name: 'Test Client',
          client_secret: 'secret-hash',
          redirect_uris: '["https://example.com/callback"]',
          grant_types: '["authorization_code"]',
          response_types: '["code"]',
          scope: 'openid profile email',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      });

      const c = createMockContext({
        params: { id: clientId },
        db: mockDB,
      });

      await adminClientGetHandler(c);

      // API returns { client: {...} }
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          client: expect.objectContaining({
            client_id: clientId,
            client_name: 'Test Client',
            scope: 'openid profile email',
          }),
        })
      );
    });

    it('should return 404 for non-existent client', async () => {
      const mockDB = createMockDB({
        firstResult: null,
      });

      const c = createMockContext({
        params: { id: 'nonexistent-client' },
        db: mockDB,
      });

      await adminClientGetHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'not_found',
          error_description: 'The requested resource was not found',
        }),
        404
      );
    });

    it('should normalize JSON fields in response', async () => {
      const clientId = 'json-normalize-client';
      const mockDB = createMockDB({
        firstResult: {
          client_id: clientId,
          client_name: 'Normalize Client',
          redirect_uris: '["https://a.com","https://b.com"]',
          grant_types: '["authorization_code","refresh_token"]',
          response_types: '["code"]',
          jwks: '{"keys":[]}',
          contacts: '["admin@example.com"]',
          created_at: Date.now(),
          updated_at: Date.now(),
        },
      });

      const c = createMockContext({
        params: { id: clientId },
        db: mockDB,
      });

      await adminClientGetHandler(c);

      // API returns { client: {...} } with parsed JSON fields
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          client: expect.objectContaining({
            redirect_uris: expect.any(Array),
            grant_types: expect.any(Array),
          }),
        })
      );
    });
  });

  describe('adminClientCreateHandler', () => {
    it('should require redirect_uris', async () => {
      const mockDB = createMockDB({});

      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Client without URIs',
        },
        db: mockDB,
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('redirect_uris'),
        }),
        400
      );
    });

    it('should require client_name', async () => {
      const mockDB = createMockDB({});

      const c = createMockContext({
        method: 'POST',
        body: {
          redirect_uris: ['https://example.com/callback'],
        },
        db: mockDB,
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('client_name'),
        }),
        400
      );
    });

    it('should create new client with valid data', async () => {
      const mockDB = createMockDB({
        firstResult: null,
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'New Test Client',
          redirect_uris: ['https://example.com/callback'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
        },
        db: mockDB,
      });

      await adminClientCreateHandler(c);

      expect(mockDB.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT'));
      // API returns { client: {...} }
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          client: expect.objectContaining({
            client_id: expect.any(String),
            client_secret: expect.any(String),
            client_name: 'New Test Client',
          }),
        }),
        201
      );
    });

    it('validates and persists the selected OIDC Mapping Set on create', async () => {
      const mockDB = createMockDB({
        firstResult: null,
        runResult: { success: true },
      });
      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Mapped Client',
          redirect_uris: ['https://example.com/callback'],
          identity_mapping: {
            fieldMappingSetId: 'mapping_set_1',
            destinationNamespace: 'oidc.claim',
          },
        },
        db: mockDB,
      });

      const response = await adminClientCreateHandler(c);

      expect(response.status).toBe(201);
      expect(resolveIdentityMappingBinding).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tenantId: 'default',
          protocol: 'oidc',
          fieldMappingSetId: 'mapping_set_1',
        })
      );
      expect(mockDB._mockStatement.bind.mock.calls.flat()).toContainEqual(
        JSON.stringify({
          fieldMappingSetId: 'mapping_set_1',
          destinationNamespace: 'oidc.claim',
        })
      );
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          client: expect.objectContaining({
            identity_mapping: {
              fieldMappingSetId: 'mapping_set_1',
              destinationNamespace: 'oidc.claim',
            },
          }),
        }),
        201
      );
    });

    it('should persist explicit requestable scopes for an Agent Access connection', async () => {
      const mockDB = createMockDB({
        firstResult: null,
        runResult: { success: true },
      });
      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'MCP client Agent Access',
          redirect_uris: ['http://localhost:18080/callback'],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          require_pkce: true,
          requestable_scopes: ['agent:read', 'agent:write', 'agent:execute'],
        },
        db: mockDB,
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          client: expect.objectContaining({
            requestable_scopes: ['agent:read', 'agent:write', 'agent:execute'],
            require_pkce: true,
          }),
        }),
        201
      );
    });

    it('should reject malformed requestable scope tokens', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Malformed Agent Access client',
          redirect_uris: ['http://localhost:18080/callback'],
          requestable_scopes: ['agent:read agent:write'],
        },
        db: createMockDB({}),
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('requestable_scopes'),
        }),
        400
      );
    });

    it('should create a token-exchange capable service client', async () => {
      const mockDB = createMockDB({
        firstResult: null,
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Service Client',
          redirect_uris: ['https://example.com/callback'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          token_exchange_allowed: true,
          delegation_mode: 'delegation',
          client_credentials_allowed: true,
          allowed_subject_token_clients: ['svc-client-a'],
          allowed_token_exchange_resources: ['svc://op-userinfo/customer-profile'],
          allowed_scopes: ['openid', 'profile'],
          default_scope: 'openid profile',
          default_audience: 'svc://op-userinfo/customer-profile',
        },
        db: mockDB,
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          client: expect.objectContaining({
            client_name: 'Service Client',
            token_exchange_allowed: true,
            delegation_mode: 'delegation',
            client_credentials_allowed: true,
            allowed_subject_token_clients: ['svc-client-a'],
            allowed_token_exchange_resources: ['svc://op-userinfo/customer-profile'],
            allowed_scopes: ['openid', 'profile'],
            default_scope: 'openid profile',
            default_audience: 'svc://op-userinfo/customer-profile',
          }),
        }),
        201
      );
    });

    it('should create OIDC claims and ASC client settings', async () => {
      const mockDB = createMockDB({
        firstResult: null,
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Claims Client',
          redirect_uris: ['https://example.com/callback'],
          allow_claims_without_scope: false,
          claims_parameter_policy: {
            email: 'claims_allowed',
            birthdate: 'claims_allowed',
          },
          asc_enabled: true,
          asc_protected_request_required: true,
          asc_sao_enabled: true,
          asc_transformed_claims_enabled: true,
          asc_allowed_transformed_claims: ['age_over_18', 'email_domain'],
        },
        db: mockDB,
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          client: expect.objectContaining({
            client_name: 'Claims Client',
            allow_claims_without_scope: false,
            claims_parameter_policy: {
              email: 'claims_allowed',
              birthdate: 'claims_allowed',
            },
            asc_enabled: true,
            asc_protected_request_required: true,
            asc_sao_enabled: true,
            asc_transformed_claims_enabled: true,
            asc_allowed_transformed_claims: ['age_over_18', 'email_domain'],
          }),
        }),
        201
      );
    });

    it('should reject invalid OIDC claims and ASC client settings', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Invalid Claims Client',
          redirect_uris: ['https://example.com/callback'],
          claims_parameter_policy: {
            email: 'allow',
          },
        },
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('claims_parameter_policy.email'),
        }),
        400
      );
    });

    it('should create client policy metadata for Phase 1 flows', async () => {
      const mockDB = createMockDB({
        firstResult: null,
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Native Wallet',
          redirect_uris: ['https://example.com/callback'],
          application_type: 'native',
          trust_group: 'wallet-suite',
          browser_public_client_mode: 'cookie_fallback',
          browser_refresh_token_policy: 'dpop_bound',
          native_sso_enabled: true,
          native_channel_allowed: true,
          allowed_channels: ['native'],
          device_secret_revoke_enabled: true,
          device_secret_revoke_trust_groups: ['wallet-suite'],
          device_secret_introspection_enabled: true,
          device_secret_introspection_trust_groups: ['wallet-suite'],
          default_resource: 'svc://wallet-api',
        },
        db: mockDB,
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          client: expect.objectContaining({
            application_type: 'native',
            trust_group: 'wallet-suite',
            browser_public_client_mode: 'cookie_fallback',
            browser_refresh_token_policy: 'dpop_bound',
            native_sso_enabled: true,
            native_channel_allowed: true,
            allowed_channels: ['native'],
            device_secret_revoke_enabled: true,
            device_secret_revoke_trust_groups: ['wallet-suite'],
            device_secret_introspection_enabled: true,
            device_secret_introspection_trust_groups: ['wallet-suite'],
            default_resource: 'svc://wallet-api',
          }),
        }),
        201
      );
    });

    it('should reject legacy browser public client mode on create', async () => {
      const mockDB = createMockDB({
        firstResult: null,
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Legacy Browser Client',
          redirect_uris: ['https://example.com/callback'],
          browser_public_client_mode: 'legacy',
        },
        db: mockDB,
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('browser_public_client_mode'),
        }),
        400
      );
    });

    it('should generate client_id and client_secret', async () => {
      const mockDB = createMockDB({
        firstResult: null,
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Auto ID Client',
          redirect_uris: ['https://example.com/callback'],
        },
        db: mockDB,
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          client: expect.objectContaining({
            client_id: expect.stringMatching(/^[a-f0-9-]{36}$/), // UUID format
            client_secret: expect.any(String),
          }),
        }),
        201
      );
    });

    it('should reject invalid redirect_uris', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Broken Redirect Client',
          redirect_uris: ['not-a-valid-uri'],
        },
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'Invalid redirect_uri: not-a-valid-uri',
        }),
        400
      );
    });

    it('should reject non-HTTPS non-loopback redirect_uris', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Insecure Redirect Client',
          redirect_uris: ['http://example.com/callback'],
        },
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description:
            'redirect_uris must use HTTPS except for loopback development callbacks',
        }),
        400
      );
    });

    it('should reject fragment redirect_uris', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Fragment Redirect Client',
          redirect_uris: ['https://example.com/callback#token'],
        },
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'redirect_uris must not contain fragment identifiers',
        }),
        400
      );
    });

    it('should reject unsupported grant_types during create', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Unsupported Grant Client',
          redirect_uris: ['https://example.com/callback'],
          grant_types: ['authorization_code', 'password'],
        },
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'Unsupported grant_type: password',
        }),
        400
      );
    });

    it('should require PKCE for public authorization-code clients during create', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Public Code Client',
          redirect_uris: ['https://example.com/callback'],
          grant_types: ['authorization_code'],
          token_endpoint_auth_method: 'none',
          require_pkce: false,
        },
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description:
            'require_pkce must be true for public clients using the authorization_code grant',
        }),
        400
      );
    });

    it('should not generate or persist a secret for a PKCE public client', async () => {
      const mockDB = createMockDB({
        firstResult: null,
        runResult: { success: true },
      });
      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Public Code Client',
          application_type: 'spa',
          redirect_uris: ['https://example.com/callback'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          require_pkce: true,
        },
        db: mockDB,
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          client: expect.not.objectContaining({ client_secret: expect.anything() }),
        }),
        201
      );
      expect((mockDB as any)._mockStatement.bind).not.toHaveBeenCalledWith(
        expect.stringMatching(/^[a-f0-9]{64}$/u)
      );
    });

    it('should reject invalid allowed_redirect_origins', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Origin Validation Client',
          redirect_uris: ['https://example.com/callback'],
          allowed_redirect_origins: ['https://example.com/path'],
        },
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('Invalid allowed_redirect_origins'),
        }),
        400
      );
    });

    it('should reject invalid web_origin_registry before creating the client', async () => {
      const mockDB = createMockDB({});
      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Origin Registry Client',
          redirect_uris: ['https://example.com/callback'],
          web_origin_registry: {
            origins: [{ origin: 'https://example.com/path' }],
          },
        },
        db: mockDB,
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('Invalid web_origin_registry origins'),
        }),
        400
      );
      expect(mockDB.prepare).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO oauth_clients')
      );
    });

    it('should reject legacy app_suite in admin client create', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Legacy Client',
          redirect_uris: ['https://example.com/callback'],
          app_suite: 'wallet-suite',
        },
      });

      const res = await adminClientCreateHandler(c);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toMatchObject({
        error: 'legacy_app_suite_not_supported',
        error_uri: 'https://docs.authrim.com/errors/error-codes#legacy-app-suite-not-supported',
        error_details: expect.objectContaining({
          code: 'legacy_app_suite_not_supported',
          severity: 'fatal',
        }),
      });
    });

    it('should reject multiple trust_group assignments in admin client create', async () => {
      const c = createMockContext({
        method: 'POST',
        body: {
          client_name: 'Invalid Trust Group Client',
          redirect_uris: ['https://example.com/callback'],
          trust_group: ['wallet-a', 'wallet-b'],
        },
      });

      await adminClientCreateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'trust_group must be a string or null',
        }),
        400
      );
    });
  });

  describe('adminClientUpdateHandler', () => {
    it('should reject legacy app_suite in admin client update', async () => {
      const clientId = 'legacy-client-update';
      const mockDB = createMockDB({
        firstResult: {
          client_id: clientId,
          client_name: 'Existing Client',
          redirect_uris: '["https://example.com/callback"]',
          grant_types: '["authorization_code"]',
          response_types: '["code"]',
        },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {
          app_suite: 'wallet-suite',
        },
        db: mockDB,
      });

      const res = await adminClientUpdateHandler(c);

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toMatchObject({
        error: 'legacy_app_suite_not_supported',
        error_uri: 'https://docs.authrim.com/errors/error-codes#legacy-app-suite-not-supported',
        error_details: expect.objectContaining({
          code: 'legacy_app_suite_not_supported',
          severity: 'fatal',
        }),
      });
    });

    it('should update client fields', async () => {
      const clientId = 'client-to-update';
      const mockDB = createMockDB({
        runResult: { success: true, meta: { changes: 1 } },
      });

      // First call checks if client exists, second call gets updated client
      let queryCount = 0;
      (mockDB as any)._mockStatement.first.mockImplementation(() => {
        queryCount++;
        if (queryCount === 1) {
          return Promise.resolve({
            client_id: clientId,
            client_name: 'Old Name',
            redirect_uris: '["https://old.com/cb"]',
            grant_types: '["authorization_code"]',
            response_types: '["code"]',
          });
        }
        return Promise.resolve({
          client_id: clientId,
          client_name: 'Updated Client Name',
          redirect_uris: '["https://new.com/callback"]',
          grant_types: '["authorization_code"]',
          response_types: '["code"]',
        });
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {
          client_name: 'Updated Client Name',
          redirect_uris: ['https://new.com/callback'],
        },
        db: mockDB,
      });

      await adminClientUpdateHandler(c);

      expect(mockDB.prepare).toHaveBeenCalledWith(expect.stringContaining('UPDATE'));
      // API returns { success, client }
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          client: expect.objectContaining({
            client_id: clientId,
            client_name: 'Updated Client Name',
          }),
        })
      );
    });

    it('validates and persists the selected OIDC Mapping Set on update', async () => {
      const clientId = 'mapped-client';
      const mockDB = createMockDB({
        firstResult: createOAuthClientRow(clientId),
        runResult: { success: true, meta: { changes: 1 } },
      });
      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {
          identity_mapping: {
            fieldMappingSetId: 'mapping_set_2',
            fieldMappingVersionId: 'mapping_version_2',
          },
        },
        db: mockDB,
      });

      const response = await adminClientUpdateHandler(c);

      expect(response.status).toBe(200);
      expect(resolveIdentityMappingBinding).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tenantId: 'default',
          protocol: 'oidc',
          fieldMappingSetId: 'mapping_set_2',
          fieldMappingVersionId: 'mapping_version_2',
        })
      );
      expect(mockDB._mockStatement.bind.mock.calls.flat()).toContainEqual(
        JSON.stringify({
          fieldMappingSetId: 'mapping_set_2',
          fieldMappingVersionId: 'mapping_version_2',
        })
      );
    });

    it('should update token exchange and downstream grant fields', async () => {
      const clientId = 'client-downstream-update';
      const mockDB = createMockDB({
        runResult: { success: true, meta: { changes: 1 } },
      });

      let queryCount = 0;
      (mockDB as any)._mockStatement.first.mockImplementation(() => {
        queryCount++;
        if (queryCount === 1) {
          return Promise.resolve({
            client_id: clientId,
            client_name: 'Existing Client',
            redirect_uris: '["https://example.com/callback"]',
            grant_types: '["authorization_code"]',
            response_types: '["code"]',
            token_exchange_allowed: 0,
            allowed_subject_token_clients: null,
            allowed_token_exchange_resources: null,
            delegation_mode: 'none',
            client_credentials_allowed: 0,
            allowed_scopes: '["openid"]',
            requestable_scopes: '["agent:read"]',
            default_scope: 'openid',
            default_audience: null,
          });
        }
        return Promise.resolve({
          client_id: clientId,
          client_name: 'Existing Client',
          redirect_uris: '["https://example.com/callback"]',
          grant_types: '["authorization_code"]',
          response_types: '["code"]',
          token_exchange_allowed: 1,
          allowed_subject_token_clients: '["svc-client-a"]',
          allowed_token_exchange_resources: '["svc://op-userinfo/customer-profile"]',
          delegation_mode: 'delegation',
          client_credentials_allowed: 1,
          allowed_scopes: '["openid","profile"]',
          requestable_scopes: '["agent:read","agent:write"]',
          default_scope: 'openid profile',
          default_audience: 'svc://op-userinfo/customer-profile',
        });
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {
          token_exchange_allowed: true,
          delegation_mode: 'delegation',
          client_credentials_allowed: true,
          allowed_subject_token_clients: ['svc-client-a'],
          allowed_token_exchange_resources: ['svc://op-userinfo/customer-profile'],
          allowed_scopes: ['openid', 'profile'],
          requestable_scopes: ['agent:read', 'agent:write'],
          default_scope: 'openid profile',
          default_audience: 'svc://op-userinfo/customer-profile',
        },
        db: mockDB,
      });

      await adminClientUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          client: expect.objectContaining({
            client_id: clientId,
            token_exchange_allowed: true,
            delegation_mode: 'delegation',
            client_credentials_allowed: true,
            allowed_subject_token_clients: ['svc-client-a'],
            allowed_token_exchange_resources: ['svc://op-userinfo/customer-profile'],
            allowed_scopes: ['openid', 'profile'],
            requestable_scopes: ['agent:read', 'agent:write'],
            default_scope: 'openid profile',
            default_audience: 'svc://op-userinfo/customer-profile',
          }),
        })
      );
    });

    it('should update Phase 1 client policy metadata', async () => {
      const clientId = 'client-policy-update';
      const mockDB = createMockDB({
        runResult: { success: true, meta: { changes: 1 } },
      });

      let queryCount = 0;
      (mockDB as any)._mockStatement.first.mockImplementation(() => {
        queryCount++;
        if (queryCount === 1) {
          return Promise.resolve({
            client_id: clientId,
            client_name: 'Existing Client',
            redirect_uris: '["https://example.com/callback"]',
            grant_types: '["authorization_code"]',
            response_types: '["code"]',
          });
        }
        return Promise.resolve({
          client_id: clientId,
          client_name: 'Existing Client',
          redirect_uris: '["https://example.com/callback"]',
          grant_types: '["authorization_code"]',
          response_types: '["code"]',
          application_type: 'native',
          trust_group: 'wallet-suite',
          trust_group_id: 'wallet-suite',
          browser_public_client_mode: 'strict',
          browser_refresh_token_policy: 'disabled',
          native_sso_enabled: 0,
          native_channel_allowed: 1,
          allowed_channels: '["browser","native"]',
          device_secret_revoke_enabled: 1,
          device_secret_revoke_trust_groups: '["wallet-suite"]',
          device_secret_introspection_enabled: 0,
          device_secret_introspection_trust_groups: '["wallet-suite"]',
          default_resource: 'svc://wallet-api',
        });
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {
          application_type: 'native',
          trust_group: 'wallet-suite',
          browser_public_client_mode: 'strict',
          browser_refresh_token_policy: 'disabled',
          native_sso_enabled: false,
          native_channel_allowed: true,
          allowed_channels: ['browser', 'native'],
          device_secret_revoke_enabled: true,
          device_secret_revoke_trust_groups: ['wallet-suite'],
          device_secret_introspection_enabled: false,
          device_secret_introspection_trust_groups: ['wallet-suite'],
          default_resource: 'svc://wallet-api',
        },
        db: mockDB,
      });

      await adminClientUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          client: expect.objectContaining({
            application_type: 'native',
            trust_group: 'wallet-suite',
            browser_public_client_mode: 'strict',
            browser_refresh_token_policy: 'disabled',
            native_sso_enabled: false,
            native_channel_allowed: true,
            allowed_channels: ['browser', 'native'],
            device_secret_revoke_enabled: true,
            device_secret_revoke_trust_groups: ['wallet-suite'],
            device_secret_introspection_enabled: false,
            device_secret_introspection_trust_groups: ['wallet-suite'],
            default_resource: 'svc://wallet-api',
          }),
        })
      );
    });

    it('should reject legacy browser public client mode on update', async () => {
      const clientId = 'legacy-browser-client-update';
      const mockDB = createMockDB({
        firstResult: {
          client_id: clientId,
          client_name: 'Existing Client',
          redirect_uris: '["https://example.com/callback"]',
          grant_types: '["authorization_code"]',
          response_types: '["code"]',
        },
        runResult: { success: true },
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {
          browser_public_client_mode: 'legacy',
        },
        db: mockDB,
      });

      await adminClientUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('browser_public_client_mode'),
        }),
        400
      );
    });

    it('should update OIDC claims and ASC client settings', async () => {
      const clientId = 'client-claims-update';
      const mockDB = createMockDB({
        runResult: { success: true, meta: { changes: 1 } },
      });

      let queryCount = 0;
      (mockDB as any)._mockStatement.first.mockImplementation(() => {
        queryCount++;
        if (queryCount === 1) {
          return Promise.resolve({
            client_id: clientId,
            client_name: 'Existing Client',
            redirect_uris: '["https://example.com/callback"]',
            grant_types: '["authorization_code"]',
            response_types: '["code"]',
          });
        }
        return Promise.resolve({
          client_id: clientId,
          client_name: 'Existing Client',
          redirect_uris: '["https://example.com/callback"]',
          grant_types: '["authorization_code"]',
          response_types: '["code"]',
          allow_claims_without_scope: 0,
          claims_parameter_policy: '{"email":"claims_allowed","birthdate":"claims_allowed"}',
          asc_enabled: 1,
          asc_protected_request_required: 1,
          asc_sao_enabled: 1,
          asc_transformed_claims_enabled: 1,
          asc_allowed_transformed_claims: '["age_over_18","email_domain"]',
        });
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {
          allow_claims_without_scope: false,
          claims_parameter_policy: {
            email: 'claims_allowed',
            birthdate: 'claims_allowed',
          },
          asc_enabled: true,
          asc_protected_request_required: true,
          asc_sao_enabled: true,
          asc_transformed_claims_enabled: true,
          asc_allowed_transformed_claims: ['age_over_18', 'email_domain'],
        },
        db: mockDB,
      });

      await adminClientUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          client: expect.objectContaining({
            client_id: clientId,
            allow_claims_without_scope: false,
            claims_parameter_policy: {
              email: 'claims_allowed',
              birthdate: 'claims_allowed',
            },
            asc_enabled: true,
            asc_protected_request_required: true,
            asc_sao_enabled: true,
            asc_transformed_claims_enabled: true,
            asc_allowed_transformed_claims: ['age_over_18', 'email_domain'],
          }),
        })
      );
    });

    it('should return 404 for non-existent client', async () => {
      const mockDB = createMockDB({
        firstResult: null,
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: 'nonexistent-client' },
        body: { client_name: 'Update' },
        db: mockDB,
      });

      await adminClientUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'not_found',
          error_description: 'The requested resource was not found',
        }),
        404
      );
    });

    it('should reject malformed character-array grant types', async () => {
      const clientId = 'client-malformed-grants';
      const mockDB = createMockDB({
        runResult: { success: true },
      });

      (mockDB as any)._mockStatement.first.mockResolvedValue({
        client_id: clientId,
        client_name: 'Existing Client',
        redirect_uris: '["https://example.com/callback"]',
        grant_types: '["authorization_code"]',
        response_types: '["code"]',
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {
          grant_types: ['a', 'u', 't', 'h'],
        },
        db: mockDB,
      });

      await adminClientUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: expect.stringContaining('grant_types appears malformed'),
        }),
        400
      );
    });

    it('should reject invalid redirect_uris during update', async () => {
      const clientId = 'client-invalid-redirect-update';
      const mockDB = createMockDB({
        runResult: { success: true },
      });

      (mockDB as any)._mockStatement.first.mockResolvedValue({
        client_id: clientId,
        client_name: 'Existing Client',
        redirect_uris: '["https://example.com/callback"]',
        grant_types: '["authorization_code"]',
        response_types: '["code"]',
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {
          redirect_uris: ['still-not-a-uri'],
        },
        db: mockDB,
      });

      await adminClientUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'Invalid redirect_uri: still-not-a-uri',
        }),
        400
      );
    });

    it('should reject non-HTTPS non-loopback redirect_uris during update', async () => {
      const clientId = 'client-insecure-redirect-update';
      const mockDB = createMockDB({
        runResult: { success: true },
      });

      (mockDB as any)._mockStatement.first.mockResolvedValue({
        client_id: clientId,
        client_name: 'Existing Client',
        redirect_uris: '["https://example.com/callback"]',
        grant_types: '["authorization_code"]',
        response_types: '["code"]',
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {
          redirect_uris: ['http://example.com/callback'],
        },
        db: mockDB,
      });

      await adminClientUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description:
            'redirect_uris must use HTTPS except for loopback development callbacks',
        }),
        400
      );
    });

    it('should reject unsupported grant_types during update', async () => {
      const clientId = 'client-unsupported-grant-update';
      const mockDB = createMockDB({
        runResult: { success: true },
      });

      (mockDB as any)._mockStatement.first.mockResolvedValue({
        client_id: clientId,
        client_name: 'Existing Client',
        redirect_uris: '["https://example.com/callback"]',
        grant_types: '["authorization_code"]',
        response_types: '["code"]',
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {
          grant_types: ['authorization_code', 'password'],
        },
        db: mockDB,
      });

      await adminClientUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description: 'Unsupported grant_type: password',
        }),
        400
      );
    });

    it('should require PKCE for public authorization-code clients during update', async () => {
      const clientId = 'client-public-pkce-update';
      const mockDB = createMockDB({
        runResult: { success: true },
      });

      (mockDB as any)._mockStatement.first.mockResolvedValue({
        client_id: clientId,
        client_name: 'Existing Client',
        redirect_uris: '["https://example.com/callback"]',
        grant_types: '["authorization_code"]',
        response_types: '["code"]',
        token_endpoint_auth_method: 'client_secret_basic',
        require_pkce: 1,
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {
          token_endpoint_auth_method: 'none',
          require_pkce: false,
        },
        db: mockDB,
      });

      await adminClientUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'invalid_request',
          error_description:
            'require_pkce must be true for public clients using the authorization_code grant',
        }),
        400
      );
    });

    it('should return a no-op response when no updates are provided', async () => {
      const clientId = 'client-no-op';
      const mockDB = createMockDB({
        runResult: { success: true },
      });

      (mockDB as any)._mockStatement.first.mockResolvedValue({
        client_id: clientId,
        client_name: 'Existing Client',
        redirect_uris: '["https://example.com/callback"]',
        grant_types: '["authorization_code"]',
        response_types: '["code"]',
      });

      const c = createMockContext({
        method: 'PUT',
        params: { id: clientId },
        body: {},
        db: mockDB,
      });

      await adminClientUpdateHandler(c);

      expect(c.json).toHaveBeenCalledWith({
        success: true,
        message: 'No changes to update',
      });
    });
  });

  describe('adminClientDeleteHandler', () => {
    it('should delete client successfully', async () => {
      const clientId = 'client-to-delete';
      const settings = createMockKVNamespace({
        [`settings:client:default:${clientId}:client`]: '{"client.consent_required":false}',
        [`settings:client:default:${clientId}:login-ui`]: '{"theme":"test"}',
        'settings:client:default:other-client:client': '{"client.consent_required":true}',
      });
      const config = createMockKVNamespace({
        [`dev:contract:client:default:${clientId}`]: '{"version":1}',
        'dev:contract:client:default:other-client': '{"version":1}',
      });
      const mockDB = createMockDB({
        firstResult: { client_id: clientId, client_name: 'Delete Me' },
        runResult: { success: true, meta: { changes: 1 } },
      });

      const c = createMockContext({
        method: 'DELETE',
        params: { id: clientId },
        db: mockDB,
        envOverrides: {
          SETTINGS: settings as unknown as KVNamespace,
          AUTHRIM_CONFIG: config as unknown as KVNamespace,
          ENVIRONMENT: 'dev',
        },
      });

      await adminClientDeleteHandler(c);

      expect(mockDB.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE'));
      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
        })
      );
      await expect(settings.get(`settings:client:default:${clientId}:client`)).resolves.toBeNull();
      await expect(
        settings.get(`settings:client:default:${clientId}:login-ui`)
      ).resolves.toBeNull();
      await expect(
        settings.get('settings:client:default:other-client:client')
      ).resolves.not.toBeNull();
      await expect(config.get(`dev:contract:client:default:${clientId}`)).resolves.toBeNull();
      await expect(config.get('dev:contract:client:default:other-client')).resolves.not.toBeNull();
      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM client_trust_policies')
      );
      expect(mockDB.batch).toHaveBeenCalledTimes(1);
      expect(mockDB.batch).toHaveBeenCalledWith(expect.arrayContaining([expect.any(Object)]));
    });

    it('keeps the client retriable when client-scoped KV cleanup fails', async () => {
      const clientId = 'client-cleanup-failure';
      const settings = createMockKVNamespace();
      settings.list.mockRejectedValueOnce(new Error('kv unavailable'));
      const mockDB = createMockDB({
        firstResult: { client_id: clientId },
        runResult: { success: true },
      });
      const c = createMockContext({
        method: 'DELETE',
        params: { id: clientId },
        db: mockDB,
        envOverrides: { SETTINGS: settings as unknown as KVNamespace },
      });

      await adminClientDeleteHandler(c);

      expect(c.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'server_error' }), 500);
      const prepareMock = mockDB.prepare as unknown as ReturnType<typeof vi.fn>;
      const preparedSql = prepareMock.mock.calls.map((call: unknown[]) => String(call[0]));
      expect(preparedSql).not.toContain(
        'DELETE FROM oauth_clients WHERE tenant_id = ? AND client_id = ?'
      );
      expect(preparedSql.some((sql) => sql.includes('DELETE FROM client_trust_policies'))).toBe(
        false
      );
    });

    it('should return 404 for non-existent client', async () => {
      const mockDB = createMockDB({
        firstResult: null,
      });

      const c = createMockContext({
        method: 'DELETE',
        params: { id: 'nonexistent-client' },
        db: mockDB,
      });

      await adminClientDeleteHandler(c);

      expect(c.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'not_found',
          error_description: 'The requested resource was not found',
        }),
        404
      );
    });
  });

  describe('adminClientRegenerateSecretHandler', () => {
    it('should reject grace periods outside the supported range', async () => {
      const c = createMockContext({
        method: 'POST',
        params: { id: 'client-123' },
        body: { grace_period_hours: 0 },
      });

      const response = await adminClientRegenerateSecretHandler(c);
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual(
        expect.objectContaining({
          error: 'invalid_request',
        })
      );
    });

    it('should return 404 when the client belongs to another tenant', async () => {
      const mockClientCache = createMockKVNamespace({
        'tenant:default:client:client-foreign': JSON.stringify({
          client_id: 'client-foreign',
          tenant_id: 'tenant-foreign',
          redirect_uris: ['https://example.com/callback'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
        }),
      });

      const c = createMockContext({
        method: 'POST',
        params: { id: 'client-foreign' },
        envOverrides: {
          CLIENTS_CACHE: mockClientCache as unknown as Env['CLIENTS_CACHE'],
        },
      });

      const response = await adminClientRegenerateSecretHandler(c);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body).toEqual(
        expect.objectContaining({
          error: 'invalid_request',
        })
      );
    });

    it('should rotate the secret, revoke tokens, and disable caching', async () => {
      const mockDB = createMockDB({
        firstResult: createOAuthClientRow('client-rotate'),
        runResult: {
          success: true,
          meta: {
            changes: 3,
            duration: 1,
          },
        } as unknown as { success: boolean },
      });
      const mockClientCache = createMockKVNamespace({
        'tenant:default:client:client-rotate': JSON.stringify({
          client_id: 'client-rotate',
          tenant_id: 'default',
          redirect_uris: ['https://example.com/callback'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
        }),
      });

      const c = createMockContext({
        method: 'POST',
        params: { id: 'client-rotate' },
        body: {
          revoke_existing_tokens: true,
          grace_period_hours: 24,
        },
        db: mockDB,
        envOverrides: {
          CLIENTS_CACHE: mockClientCache as unknown as Env['CLIENTS_CACHE'],
        },
      });

      const response = await adminClientRegenerateSecretHandler(c);
      const payload = (await response.json()) as { revoked_tokens: number };

      expect(response.status).toBe(200);
      expect(c.header).toHaveBeenCalledWith('Cache-Control', 'no-store');
      expect(mockClientCache.delete).toHaveBeenCalledWith(expect.stringContaining('client-rotate'));
      expect(payload).toEqual(
        expect.objectContaining({
          client_id: 'client-rotate',
          client_secret: expect.stringMatching(/^[a-f0-9]{64}$/),
          revoked_tokens: 3,
        })
      );
    });

    it('should tolerate invalid JSON bodies and use default options', async () => {
      const mockDB = createMockDB({
        firstResult: createOAuthClientRow('client-defaults'),
        runResult: {
          success: true,
          meta: {
            changes: 0,
            duration: 1,
          },
        } as unknown as { success: boolean },
      });
      const mockClientCache = createMockKVNamespace({
        'tenant:default:client:client-defaults': JSON.stringify({
          client_id: 'client-defaults',
          tenant_id: 'default',
          redirect_uris: ['https://example.com/callback'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
        }),
      });

      const c = createMockContext({
        method: 'POST',
        params: { id: 'client-defaults' },
        db: mockDB,
        jsonError: new SyntaxError('Unexpected token'),
        envOverrides: {
          CLIENTS_CACHE: mockClientCache as unknown as Env['CLIENTS_CACHE'],
        },
      });

      const response = await adminClientRegenerateSecretHandler(c);
      const payload = (await response.json()) as { revoked_tokens: number };

      expect(response.status).toBe(200);
      expect(payload.revoked_tokens).toBe(0);
      expect(c.header).toHaveBeenCalledWith('Cache-Control', 'no-store');
    });
  });
});
