/**
 * SCIM 2.0 Endpoint Tests
 * Tests RFC 7643 (Core Schema) and RFC 7644 (Protocol) compliance
 *
 * Covers:
 * - Bearer token authentication
 * - Expired/invalid token rejection
 * - User CRUD operations
 * - Group CRUD operations
 * - Filter expression handling
 * - ETag/If-Match concurrency control
 * - Pagination
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import scimApp from '../scim';

vi.mock('../scim-identifier-replacement', () => ({
  syncScimIdentifierReplacements: vi.fn(async () => {}),
}));

const canonicalRuntimeState = vi.hoisted(() => ({
  users: new Map<string, any>(),
  apply(input: any) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const existing = this.users.get(input.userId) ?? {};
    this.users.set(input.userId, {
      ...existing,
      id: input.userId,
      tenant_id: input.tenantId,
      email: input.sensitiveValues?.email ?? existing.email ?? null,
      email_verified: input.emailVerified ? 1 : 0,
      phone_number: input.sensitiveValues?.phone_number ?? existing.phone_number ?? null,
      phone_number_verified: input.phoneNumberVerified ? 1 : 0,
      name: input.sensitiveValues?.name ?? existing.name ?? null,
      given_name: input.sensitiveValues?.given_name ?? existing.given_name ?? null,
      family_name: input.sensitiveValues?.family_name ?? existing.family_name ?? null,
      middle_name: input.sensitiveValues?.middle_name ?? existing.middle_name ?? null,
      nickname: input.sensitiveValues?.nickname ?? existing.nickname ?? null,
      preferred_username:
        input.sensitiveValues?.preferred_username ?? existing.preferred_username ?? null,
      profile: input.sensitiveValues?.profile ?? existing.profile ?? null,
      picture: input.sensitiveValues?.picture ?? existing.picture ?? null,
      website: input.sensitiveValues?.website ?? existing.website ?? null,
      gender: input.sensitiveValues?.gender ?? existing.gender ?? null,
      birthdate: input.sensitiveValues?.birthdate ?? existing.birthdate ?? null,
      zoneinfo: input.sensitiveValues?.zoneinfo ?? input.zoneinfo ?? existing.zoneinfo ?? null,
      locale: input.sensitiveValues?.locale ?? input.locale ?? existing.locale ?? null,
      address_json: input.addressJson ?? existing.address_json ?? null,
      custom_attributes_json: input.customAttributesJson ?? existing.custom_attributes_json ?? null,
      password_hash: input.passwordHash ?? existing.password_hash ?? null,
      external_id: input.externalId ?? existing.external_id ?? null,
      active: input.active === false ? 0 : 1,
      lifecycle_state: input.active === false ? 'deprovisioned' : 'active',
      created_at: existing.created_at ?? nowSeconds,
      updated_at: nowSeconds,
    });
  },
}));

const accountCreationState = vi.hoisted(() => ({
  deliveryStatus: 201 as 201 | 202,
  capacityUnavailable: false,
  registryGenerationPropagating: false,
  bindingUnavailable: false,
  calls: [] as Array<Record<string, unknown>>,
  pause: null as null | (() => Promise<void>),
  inFlight: 0,
  maxInFlight: 0,
}));

const accountOperationState = vi.hoisted(() => ({
  operation: null as Record<string, unknown> | null,
  error: null as Error | null,
}));

const accountRoutingState = vi.hoisted(() => ({
  error: null as Error | null,
  calls: [] as string[],
}));

const customClaimRoutingState = vi.hoisted(() => ({
  rejectAccountLookup: false,
}));

const accountRemovalState = vi.hoisted(() => ({
  prepare: vi.fn(async (_env, input) => [
    {
      operationId: `remove:${input.userId}`,
      tenantId: input.tenantId,
      accountId: `account:${input.userId}`,
    },
  ]),
  ready: vi.fn(),
  attempt: vi.fn(),
  erase: vi.fn(),
}));

vi.mock('../cross-shard-account-list', () => ({
  CrossShardAccountListService: class {
    private readonly env: Partial<Env>;

    constructor(env: Partial<Env>) {
      this.env = env;
    }

    async list(input: { tenantId: string; limit?: number; includeInactive?: boolean }) {
      const limit = input.limit ?? 100;
      const items = [...canonicalRuntimeState.users.values()]
        .filter(
          (user) =>
            user.lifecycle_state !== 'deleted' && (input.includeInactive || user.active !== 0)
        )
        .sort((left, right) => Number(right.created_at) - Number(left.created_at))
        .slice(0, limit)
        .map((user) => ({
          id: `account:${user.id}`,
          legacyUserId: user.id,
          tenantId: input.tenantId,
          accountType: 'user',
          lifecycleState: user.active === 0 ? 'deprovisioned' : 'active',
          displayLabel: user.name ?? null,
          createdAt: Number(user.created_at),
          coreBindingRef: 'DB',
          piiBindingRef: 'DB_PII',
        }));
      if (!this.env.DB || !this.env.DB_PII) throw new Error('test_scim_route_binding_missing');
      return { items, nextCursor: null };
    }

    async count(input: { includeInactive?: boolean }) {
      return [...canonicalRuntimeState.users.values()].filter(
        (user) => user.lifecycle_state !== 'deleted' && (input.includeInactive || user.active !== 0)
      ).length;
    }
  },
  CrossShardAccountExactSearchService: class {
    private readonly env: Partial<Env>;

    constructor(env: Partial<Env>) {
      this.env = env;
    }

    async find(input: {
      tenantId: string;
      identifier: string;
      purpose?: string;
      indexKind?: string;
    }) {
      const matchingEntry =
        input.indexKind === 'external_subject'
          ? [...canonicalRuntimeState.users.entries()].find(
              ([, user]) =>
                String(user.preferred_username ?? '').toLowerCase() ===
                input.identifier.toLowerCase()
            )
          : input.indexKind === 'email_exact'
            ? [...canonicalRuntimeState.users.entries()].find(
                ([, user]) =>
                  String(user.email ?? '').toLowerCase() === input.identifier.toLowerCase()
              )
            : null;
      const userId = matchingEntry?.[0] ?? input.identifier.replace(/^account:/, '');
      accountRoutingState.calls.push(userId);
      if (accountRoutingState.error) throw accountRoutingState.error;
      const user = matchingEntry?.[1] ?? canonicalRuntimeState.users.get(userId);
      if (!user || (input.purpose === 'active_search' && user.active === 0)) return [];
      if (!this.env.DB || !this.env.DB_PII) throw new Error('test_scim_route_binding_missing');
      return [
        {
          id: `account:${userId}`,
          legacyUserId: userId,
          tenantId: input.tenantId,
          accountType: 'user',
          lifecycleState: user.active === 0 ? 'deprovisioned' : 'active',
          displayLabel: user.name ?? null,
          createdAt: Number(user.created_at),
          coreBindingRef: 'DB',
          piiBindingRef: 'DB_PII',
        },
      ];
    }
  },
}));

vi.mock('../account-directory-removal-producer', () => ({
  prepareAccountDirectoryRemoval: accountRemovalState.prepare,
  markAccountDirectoryRemovalsReady: accountRemovalState.ready,
  attemptImmediateAccountDirectoryRemovals: accountRemovalState.attempt,
  eraseAccountPiiAfterDirectoryRemovalPrepared: accountRemovalState.erase,
}));

vi.mock('../account-creation-operation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../account-creation-operation')>();
  return {
    ...actual,
    AccountCreationOperationRepository: class {
      async findForActor() {
        if (accountOperationState.error) throw accountOperationState.error;
        return accountOperationState.operation;
      }
    },
  };
});

vi.mock('../account-authoritative-write', () => ({
  writeCanonicalAccountAuthoritative: vi.fn(async ({ publication, runtimeUser }: any) => {
    const userId = publication.accountId.slice('account:'.length);
    canonicalRuntimeState.apply({
      ...runtimeUser,
      userId,
      tenantId: publication.tenantId,
    });
    return { userId };
  }),
}));

vi.mock('../account-directory-producer', () => ({
  executeDurableInitialAccountDirectoryWrite: vi.fn(
    async (env: any, input: any, dependencies: any) => {
      accountCreationState.calls.push(input);
      accountCreationState.inFlight += 1;
      accountCreationState.maxInFlight = Math.max(
        accountCreationState.maxInFlight,
        accountCreationState.inFlight
      );
      if (accountCreationState.pause) await accountCreationState.pause();
      accountCreationState.inFlight -= 1;
      if (accountCreationState.capacityUnavailable) {
        throw new Error('control_account_allocation_capacity_unavailable');
      }
      if (accountCreationState.registryGenerationPropagating) {
        throw new Error('lookup_registry_generation_mismatch');
      }
      if (
        input.email &&
        [...canonicalRuntimeState.users.values()].some(
          (user) => user.email?.toLowerCase() === input.email.toLowerCase()
        )
      ) {
        throw new Error('directory_identifier_reservation_conflict');
      }
      if (
        input.externalSubject &&
        [...canonicalRuntimeState.users.values()].some(
          (user) =>
            user.lifecycle_state !== 'deleted' &&
            user.preferred_username?.trim().toLowerCase() === input.externalSubject.subject
        )
      ) {
        throw new Error('directory_identifier_reservation_conflict');
      }
      const core = await import('@authrim/ar-lib-core');
      const publication = {
        operationId: input.candidateOperationId,
        tenantId: input.tenantId,
        accountId: `account:${input.candidateUserId}`,
        idempotencyKey: `account-create:${'a'.repeat(64)}`,
        routeProjection: {
          schemaVersion: 1,
          accountRouteGeneration: 1,
          residencyPolicyId: input.residencyPolicyId,
          targets: [],
        },
        indexes: [],
      };
      await dependencies.writeAuthoritative({
        publication,
        tenantCoreUsers: core.ensureDatabaseAdapter(env.DB),
        tenantPii: core.ensureDatabaseAdapter(env.DB_PII),
        residencyPartition: input.residencyPartition,
      });
      return {
        publication,
        operation: {
          operationId: publication.operationId,
          tenantId: input.tenantId,
          actorId: input.actorId,
          idempotencyKey: input.idempotencyKey,
          allocationIdempotencyKey: publication.idempotencyKey,
          requestHash: input.requestHash,
          userId: input.candidateUserId,
          accountId: publication.accountId,
          status: accountCreationState.deliveryStatus === 201 ? 'succeeded' : 'directory_pending',
          publication,
        },
        delivery: {
          status: accountCreationState.deliveryStatus,
          accountId: publication.accountId,
          operationId: publication.operationId,
        },
      };
    }
  ),
  resolveInitialAccountDirectoryWriteTargets: vi.fn(async (env: any) => {
    if (accountCreationState.bindingUnavailable) {
      throw new Error('account_directory_write_binding_unavailable');
    }
    return {
      tenantCoreUsers: env.DB,
      tenantPii: env.DB_PII,
      residencyPartition: 'default',
    };
  }),
}));

// Mock scim-auth middleware at module level (now from @authrim/ar-lib-scim package)
vi.mock('@authrim/ar-lib-scim', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-scim')>();
  return {
    ...actual,
    scimAuthMiddleware: vi.fn().mockImplementation(async (c: any, next: () => Promise<void>) => {
      // Allow all requests by default; specific tests override this
      const authHeader = c.req.header('Authorization');
      if (!authHeader) {
        return c.json(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
            status: '401',
            detail: 'No authorization header provided',
          },
          401
        );
      }
      if (!authHeader.startsWith('Bearer ')) {
        return c.json(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
            status: '401',
            detail: 'Invalid authorization header format',
          },
          401
        );
      }
      const token = authHeader.split(' ')[1];
      if (token === 'expired-token') {
        return c.json(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
            status: '401',
            detail: 'Invalid or expired SCIM token',
          },
          401
        );
      }
      if (token === 'invalid-token') {
        return c.json(
          {
            schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
            status: '401',
            detail: 'Invalid or expired SCIM token',
          },
          401
        );
      }
      await next();
    }),
  };
});

vi.mock('../scim-identity-mapping', () => {
  return {
    applyScimInboundIdentityMapping: vi.fn(async ({ user }: { user: any }) => {
      const primaryEmail = user.emails?.find((item: any) => item.primary) ?? user.emails?.[0];
      const primaryPhone =
        user.phoneNumbers?.find((item: any) => item.primary) ?? user.phoneNumbers?.[0];
      const enterprise = user['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'] ?? {};
      const customAttributes = Object.fromEntries(
        Object.entries(enterprise).filter(([, value]) => value !== undefined)
      );
      return {
        external_id: user.externalId,
        preferred_username: user.userName,
        active: user.active === undefined ? undefined : user.active ? 1 : 0,
        name: user.displayName ?? user.name?.formatted,
        given_name: user.name?.givenName,
        family_name: user.name?.familyName,
        middle_name: user.name?.middleName,
        nickname: user.nickName,
        profile: user.profileUrl,
        locale: user.preferredLanguage,
        zoneinfo: user.timezone,
        email: primaryEmail?.value,
        phone_number: primaryPhone?.value,
        custom_attributes_json:
          Object.keys(customAttributes).length > 0 ? JSON.stringify(customAttributes) : undefined,
      };
    }),
    ScimIdentityMappingError: class extends Error {
      constructor(
        message: string,
        readonly code: string
      ) {
        super(message);
      }
    },
  };
});

vi.mock('../scim-settings', () => ({
  getScimInboundSettings: vi.fn(async () => ({
    enabled: true,
    usersEnabled: true,
    groupsEnabled: true,
    bulkEnabled: true,
    mappingSetId: 'test-scim-mapping',
    bulkMaxOperations: 100,
    bulkMaxPayloadSize: 1_048_576,
  })),
}));

// Mock shared utilities
vi.mock('@authrim/ar-lib-core/utils/id', () => ({
  generateUserId: vi
    .fn()
    .mockImplementation(() => `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`),
  isValidUserId: vi.fn().mockReturnValue(true),
  getUserIdFormatFromSettings: vi.fn().mockResolvedValue('nanoid'),
  generateUserIdFromSettings: vi
    .fn()
    .mockImplementation(
      async () => `user-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
    ),
  DEFAULT_USER_ID_FORMAT: 'nanoid',
}));

vi.mock('@authrim/ar-lib-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@authrim/ar-lib-core')>();
  const toProjection = (user: any) => ({
    id: user.id,
    tenant_id: user.tenant_id || 'default',
    subject_id: `subject:${user.id}`,
    account_id: `account:${user.id}`,
    account_type: 'user',
    lifecycle_state: user.lifecycle_state ?? (user.active === 0 ? 'deprovisioned' : 'active'),
    email: user.email ?? null,
    email_verified: user.email_verified ?? 0,
    name: user.name ?? null,
    given_name: user.given_name ?? null,
    family_name: user.family_name ?? null,
    middle_name: user.middle_name ?? null,
    nickname: user.nickname ?? null,
    preferred_username: user.preferred_username ?? null,
    profile: user.profile ?? null,
    picture: user.picture ?? null,
    website: user.website ?? null,
    gender: user.gender ?? null,
    birthdate: user.birthdate ?? null,
    zoneinfo: user.zoneinfo ?? null,
    locale: user.locale ?? null,
    phone_number: user.phone_number ?? null,
    phone_number_verified: user.phone_number_verified ?? 0,
    address_json: user.address_json ?? null,
    password_hash: user.password_hash ?? null,
    external_id: user.external_id ?? null,
    last_login_at: user.last_login_at ?? null,
    active: user.active === 0 ? 0 : 1,
    custom_attributes_json: user.custom_attributes_json ?? null,
    created_at:
      typeof user.created_at === 'number'
        ? new Date(user.created_at * 1000).toISOString()
        : user.created_at,
    updated_at:
      typeof user.updated_at === 'number'
        ? new Date(user.updated_at * 1000).toISOString()
        : user.updated_at,
  });
  const applyRuntimeUserInput = (input: any) => canonicalRuntimeState.apply(input);
  return {
    ...actual,
    invalidateUserCache: vi.fn().mockResolvedValue(undefined),
    getTenantIdFromContext: vi.fn().mockReturnValue('default'),
    createAuthContextFromHono: vi.fn((c: any, tenantId = 'default') => ({
      tenantId,
      coreAdapter: actual.ensureDatabaseAdapter(c.env.DB, 'test-scim-metadata'),
      repositories: {},
      cache: new Map(),
      honoContext: c,
    })),
    resolveAccountDataContext: vi.fn(async (env: Partial<Env>, input: { accountId: string }) => {
      const userId = input.accountId.replace(/^account:/, '');
      accountRoutingState.calls.push(userId);
      if (accountRoutingState.error) throw accountRoutingState.error;
      if (!canonicalRuntimeState.users.has(userId)) {
        throw new Error('account_data_route_not_found');
      }
      return {
        tenantId: 'default',
        accountId: `account:${userId}`,
        legacyUserId: userId,
        coreDb: env.DB,
        piiDb: env.DB_PII,
      };
    }),
    resolveAccountDataContextFromHono: vi.fn(async (c: any, accountId: string) => {
      const userId = accountId.replace(/^account:/, '');
      accountRoutingState.calls.push(userId);
      if (accountRoutingState.error) throw accountRoutingState.error;
      if (!canonicalRuntimeState.users.has(userId)) {
        throw new Error('account_data_route_not_found');
      }
      return {
        tenantId: 'default',
        accountId: `account:${userId}`,
        legacyUserId: userId,
        coreDb: c.env.DB,
        piiDb: c.env.DB_PII,
      };
    }),
    generateUserIdFromSettings: vi
      .fn()
      .mockImplementation(
        async () => `user-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
      ),
    resolveCustomClaimRuntimeSourcesFromEnv: vi.fn(
      async (env: Partial<Env>, _tenantId: string, options?: { accountId?: string }) => {
        if (options?.accountId && customClaimRoutingState.rejectAccountLookup) {
          throw new Error('lookup_destination_revalidation_failed');
        }
        return {
          schemaDb: env.DB,
          nonPiiDb: env.DB,
          piiDb: env.DB_PII ?? null,
        };
      }
    ),
    CanonicalRuntimeUserProjectionRepository: class {
      async findByLegacyUserId(legacyUserId: string, options?: { includeInactive?: boolean }) {
        const user = canonicalRuntimeState.users.get(legacyUserId);
        if (!user || (!options?.includeInactive && user.active === 0)) {
          return null;
        }
        return toProjection(user);
      }

      async findByAccountId(accountId: string, options?: { includeInactive?: boolean }) {
        return this.findByLegacyUserId(accountId.replace(/^account:/, ''), options);
      }
    },
    CanonicalRuntimeUserWriter: class {
      async createFromRuntimeUser(input: any) {
        applyRuntimeUserInput(input);
        return { created: true, graph: null, profileAttributeCount: 0, contactPointCount: 0 };
      }

      async syncFromRuntimeUser(input: any) {
        applyRuntimeUserInput(input);
        return { created: false, graph: null, profileAttributeCount: 0, contactPointCount: 0 };
      }

      async deleteRuntimeUser(userId: string) {
        const user = canonicalRuntimeState.users.get(userId);
        if (!user) {
          return false;
        }
        user.active = 0;
        user.lifecycle_state = 'deleted';
        user.updated_at = Math.floor(Date.now() / 1000);
        return true;
      }
    },
    CanonicalSensitiveValueResolver: class {},
    CanonicalIdentityRepository: class {},
  };
});

describe('SCIM 2.0 Endpoints', () => {
  let app: Hono;
  let mockEnv: Partial<Env>;
  let mockUsers: Map<string, any>;
  let mockGroups: Map<string, any>;
  let mockUserRoles: Map<string, any[]>;
  let mockCustomClaimSchemas: Array<Record<string, unknown>>;
  let activeLegalHolds: Map<string, string>;
  let sessionRevocationStates: Map<
    string,
    { lifecycle: string; lifecycleVersionMs: number | null }
  >;

  function createCustomClaimSchemaRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'schema-1',
      tenant_id: 'default',
      field_key: 'department',
      display_label: 'Department',
      field_type: 'string',
      is_pii: 1,
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
      created_at: Math.floor(Date.now() / 1000),
      updated_at: Math.floor(Date.now() / 1000),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    accountCreationState.deliveryStatus = 201;
    accountCreationState.capacityUnavailable = false;
    accountCreationState.registryGenerationPropagating = false;
    accountCreationState.bindingUnavailable = false;
    accountCreationState.calls = [];
    accountCreationState.pause = null;
    accountCreationState.inFlight = 0;
    accountCreationState.maxInFlight = 0;
    accountOperationState.operation = null;
    accountOperationState.error = null;
    accountRoutingState.error = null;
    accountRoutingState.calls = [];
    customClaimRoutingState.rejectAccountLookup = false;
    mockUsers = new Map();
    canonicalRuntimeState.users = mockUsers;
    mockGroups = new Map();
    mockUserRoles = new Map();
    mockCustomClaimSchemas = [];
    activeLegalHolds = new Map();
    sessionRevocationStates = new Map();

    // Seed some test data (timestamps as Unix seconds, matching D1 database format)
    const jan15 = Math.floor(new Date('2024-01-15T10:00:00Z').getTime() / 1000);
    const jan16 = Math.floor(new Date('2024-01-16T10:00:00Z').getTime() / 1000);
    const jan10 = Math.floor(new Date('2024-01-10T10:00:00Z').getTime() / 1000);

    mockUsers.set('user-001', {
      id: 'user-001',
      email: 'john.doe@example.com',
      email_verified: 1,
      name: 'John Doe',
      given_name: 'John',
      family_name: 'Doe',
      preferred_username: 'johndoe',
      active: 1,
      external_id: 'ext-001',
      created_at: jan15,
      updated_at: jan15,
    });

    mockUsers.set('user-002', {
      id: 'user-002',
      email: 'jane.smith@example.com',
      email_verified: 1,
      name: 'Jane Smith',
      given_name: 'Jane',
      family_name: 'Smith',
      preferred_username: 'janesmith',
      active: 1,
      external_id: 'ext-002',
      created_at: jan16,
      updated_at: jan16,
    });

    mockGroups.set('group-001', {
      id: 'group-001',
      name: 'Administrators',
      description: 'Admin group',
      external_id: 'ext-grp-001',
      created_at: jan10,
    });

    // Mock database
    mockEnv = {
      DB: {
        prepare: vi.fn().mockImplementation((sql: string) => {
          return {
            bind: vi.fn().mockImplementation((...args: any[]) => {
              if (args.some((value) => value === undefined)) {
                throw new Error(`D1_TYPE_ERROR: undefined bind value for ${sql}`);
              }
              return {
                first: vi.fn().mockImplementation(async () => {
                  if (sql.includes('FROM legal_holds hold')) {
                    const holdId = activeLegalHolds.get(args[1]);
                    return holdId ? { hold_id: holdId, reason_code: 'litigation' } : null;
                  }
                  if (sql.includes('FROM identity_accounts')) {
                    const userId = sql.includes('legacy_user_id = ?') ? args[0] : args[0];
                    const user = mockUsers.get(userId);
                    if (!user) return null;
                    return {
                      id: `account:${user.id}`,
                      tenant_id: user.tenant_id || 'default',
                      account_type: 'user',
                      lifecycle_state: user.active === 0 ? 'deleted' : 'active',
                      subject_lifecycle_state: user.active === 0 ? 'deleted' : 'active',
                      directory_publication_state: 'active',
                      legacy_user_id: user.id,
                      primary_subject_id: `subject:${user.id}`,
                      display_label: null,
                      metadata_json: JSON.stringify({
                        external_id: user.external_id ?? null,
                        password_hash: user.password_hash ?? null,
                      }),
                      created_at: user.created_at,
                      updated_at: user.updated_at,
                      account_updated_at: user.updated_at,
                      deleted_at: null,
                    };
                  }
                  // Handle SELECT queries for users_core (PII/Non-PII separation)
                  if (sql.includes('FROM users_core WHERE id = ?')) {
                    const user = mockUsers.get(args[0]);
                    if (!user) return null;
                    return {
                      id: user.id,
                      tenant_id: user.tenant_id || 'default',
                      email_verified: user.email_verified,
                      phone_number_verified: 0,
                      is_active: user.active,
                      user_type: 'end_user',
                      external_id: user.external_id,
                      pii_partition: 'default',
                      pii_status: 'active',
                      created_at: user.created_at,
                      updated_at: user.updated_at,
                    };
                  }
                  if (sql.includes('SELECT COUNT(*) as total')) {
                    if (sql.includes('users') || sql.includes('users_core'))
                      return { total: mockUsers.size };
                    if (sql.includes('roles')) return { total: mockGroups.size };
                  }
                  if (sql.includes('SELECT * FROM roles WHERE id = ?')) {
                    return mockGroups.get(args[0]) || null;
                  }
                  if (sql.includes('SELECT id FROM roles WHERE name = ?')) {
                    for (const group of mockGroups.values()) {
                      if (group.name === args[0]) return { id: group.id };
                    }
                    return null;
                  }
                  return null;
                }),
                all: vi.fn().mockImplementation(async () => {
                  if (sql.includes('FROM identity_accounts')) {
                    const results = Array.from(mockUsers.values())
                      .filter(
                        (user) => !sql.includes("lifecycle_state = 'active'") || user.active !== 0
                      )
                      .map((user) => ({
                        id: `account:${user.id}`,
                        tenant_id: user.tenant_id || 'default',
                        account_type: 'user',
                        lifecycle_state: user.active === 0 ? 'deleted' : 'active',
                        legacy_user_id: user.id,
                        primary_subject_id: `subject:${user.id}`,
                        display_label: null,
                        metadata_json: JSON.stringify({
                          external_id: user.external_id ?? null,
                          password_hash: user.password_hash ?? null,
                        }),
                        created_at: user.created_at,
                        updated_at: user.updated_at,
                        deleted_at: null,
                      }));
                    return { results };
                  }
                  // Handle SELECT queries for users_core list (PII/Non-PII separation)
                  if (sql.includes('FROM users_core')) {
                    const results = Array.from(mockUsers.values()).map((user) => ({
                      id: user.id,
                      tenant_id: user.tenant_id || 'default',
                      email_verified: user.email_verified,
                      phone_number_verified: 0,
                      is_active: user.active,
                      user_type: 'end_user',
                      external_id: user.external_id,
                      pii_partition: 'default',
                      pii_status: 'active',
                      created_at: user.created_at,
                      updated_at: user.updated_at,
                    }));
                    return { results };
                  }
                  if (sql.includes('FROM custom_claim_schemas')) {
                    return { results: mockCustomClaimSchemas };
                  }
                  if (sql.includes('FROM user_custom_fields')) {
                    const userId = args[0];
                    const fieldNames = args.slice(2);
                    const user = mockUsers.get(userId);
                    const customFields = user?.custom_fields || {};
                    const results = Object.entries(customFields)
                      .filter(
                        ([fieldName]) => fieldNames.length === 0 || fieldNames.includes(fieldName)
                      )
                      .map(([field_name, field_value]) => ({
                        field_name,
                        field_value,
                      }));
                    return { results };
                  }
                  if (sql.includes('FROM user_roles ur')) {
                    const userId = args[1];
                    const results = [...mockUserRoles.entries()].flatMap(([roleId, members]) => {
                      if (!members.some((member) => member.user_id === userId)) return [];
                      const role = mockGroups.get(roleId);
                      return role ? [{ id: role.id, name: role.name }] : [];
                    });
                    return { results };
                  }
                  if (sql.includes('SELECT * FROM roles')) {
                    return { results: Array.from(mockGroups.values()) };
                  }
                  if (sql.includes('SELECT ur.user_id')) {
                    const roleId = args[0];
                    const members = mockUserRoles.get(roleId) || [];
                    return { results: members };
                  }
                  return { results: [] };
                }),
                run: vi.fn().mockImplementation(async () => {
                  if (sql.includes('UPDATE identity_accounts SET')) {
                    const userId = sql.includes('legacy_user_id IN')
                      ? args[args.length - 1]
                      : String(args[2] || '').replace(/^account:/, '');
                    const user = mockUsers.get(userId);
                    if (user) {
                      if (args[0] === 'suspended' || args[0] === 'deleted') {
                        user.active = 0;
                      }
                      if (args[0] === 'active') {
                        user.active = 1;
                      }
                      user.updated_at = Math.floor(Date.now() / 1000);
                    }
                    return { success: true };
                  }
                  // Handle INSERT into users_core (PII/Non-PII separation)
                  if (sql.includes('INSERT INTO users_core')) {
                    // bind() order:
                    // id, tenant_id, email_verified, phone_number_verified, email_domain_hash,
                    // password_hash, is_active, user_type, pii_partition, pii_status,
                    // lifecycle_state, created_at, updated_at, last_login_at
                    const userId = args[0];
                    // Timestamps are stored as Unix seconds (matching D1 database format)
                    const nowSeconds = Math.floor(Date.now() / 1000);
                    mockUsers.set(userId, {
                      id: userId,
                      tenant_id: args[1],
                      email_verified: args[2],
                      active: args[6],
                      external_id: null,
                      created_at: args[11] ?? nowSeconds,
                      updated_at: args[12] ?? nowSeconds,
                    });
                    return { success: true };
                  }
                  // Handle UPDATE users_core SET (PII/Non-PII separation)
                  if (sql.includes('UPDATE users_core SET')) {
                    const userId = sql.includes('tenant_id = ?')
                      ? args[args.length - 2]
                      : args[args.length - 1];
                    const user = mockUsers.get(userId);
                    if (user) {
                      user.updated_at = Math.floor(Date.now() / 1000);
                      // Handle soft delete (is_active = 0)
                      if (sql.includes('is_active = 0')) {
                        user.active = 0;
                      }
                    }
                    return { success: true };
                  }
                  if (sql.includes('INSERT INTO user_custom_fields')) {
                    const userId = args[0];
                    const user = mockUsers.get(userId);
                    if (user) {
                      user.custom_fields = user.custom_fields || {};
                      user.custom_fields[args[1]] = args[2];
                    }
                    return { success: true };
                  }
                  if (sql.includes('DELETE FROM user_custom_fields')) {
                    const userId = args[0];
                    const user = mockUsers.get(userId);
                    if (user?.custom_fields) {
                      delete user.custom_fields[args[2]];
                    }
                    return { success: true };
                  }
                  if (sql.includes('INSERT INTO roles')) {
                    const groupId = args[0];
                    mockGroups.set(groupId, {
                      id: groupId,
                      tenant_id: args[1],
                      name: args[2],
                      description: args[3],
                      external_id: args[5],
                      created_at: args[6],
                    });
                    return { success: true };
                  }
                  if (sql.includes('UPDATE roles SET')) {
                    const groupId = sql.includes('tenant_id = ?')
                      ? args[args.length - 2]
                      : args[args.length - 1];
                    const group = mockGroups.get(groupId);
                    if (group) {
                      group.name = args[0];
                      group.description = args[1];
                    }
                    return { success: true };
                  }
                  if (sql.includes('DELETE FROM roles')) {
                    mockGroups.delete(args[0]);
                    return { success: true };
                  }
                  if (sql.includes('DELETE FROM user_roles')) {
                    mockUserRoles.delete(args[0]);
                    return { success: true };
                  }
                  if (sql.includes('INSERT INTO user_roles')) {
                    const userId = args[0];
                    const roleId = args[1];
                    const members = mockUserRoles.get(roleId) || [];
                    members.push({ user_id: userId, email: mockUsers.get(userId)?.email });
                    mockUserRoles.set(roleId, members);
                    return { success: true };
                  }
                  return { success: true };
                }),
              };
            }),
          };
        }),
        batch: vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) =>
          Promise.all(statements.map((statement) => statement.run()))
        ),
      } as any,
      // DB_PII mock for PII/Non-PII DB separation
      DB_PII: {
        prepare: vi.fn().mockImplementation((sql: string) => {
          return {
            bind: vi.fn().mockImplementation((...args: any[]) => ({
              first: vi.fn().mockImplementation(async () => {
                if (sql.includes('FROM identity_sensitive_values')) {
                  const valueKey = sql.includes("value_key = 'email'") ? 'email' : args[2];
                  if (valueKey === 'email' && sql.includes('value_json = ?')) {
                    const email = JSON.parse(args[1]);
                    for (const user of mockUsers.values()) {
                      if (user.email === email && user.active !== 0) {
                        return { id: user.id };
                      }
                    }
                    return null;
                  }
                  const ownerId = args[1];
                  const user = mockUsers.get(ownerId);
                  if (!user || user.active === 0) {
                    return null;
                  }
                  const value = user[valueKey];
                  return { value_json: value === undefined ? null : JSON.stringify(value) };
                }
                // Handle SELECT queries for PII data
                if (
                  sql.includes(
                    'SELECT custom_attributes_json FROM users_pii WHERE id = ? AND tenant_id = ?'
                  )
                ) {
                  const user = mockUsers.get(args[0]);
                  if (!user) return null;
                  return {
                    custom_attributes_json: user.custom_attributes_json || null,
                  };
                }
                if (sql.includes('SELECT') && sql.includes('FROM users_pii WHERE id = ?')) {
                  const user = mockUsers.get(args[0]);
                  if (!user) return null;
                  return {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    given_name: user.given_name,
                    family_name: user.family_name,
                    middle_name: null,
                    nickname: null,
                    preferred_username: user.preferred_username,
                    profile: null,
                    picture: null,
                    website: null,
                    gender: null,
                    birthdate: null,
                    zoneinfo: null,
                    locale: null,
                    phone_number: null,
                    address_formatted: null,
                    address_street_address: null,
                    address_locality: null,
                    address_region: null,
                    address_postal_code: null,
                    address_country: null,
                    custom_attributes_json: user.custom_attributes_json || null,
                  };
                }
                // Handle email uniqueness check
                if (sql.includes('SELECT id FROM users_pii WHERE') && sql.includes('email')) {
                  const emailArg = sql.includes('tenant_id') ? args[1] : args[0];
                  for (const user of mockUsers.values()) {
                    if (user.email === emailArg) return { id: user.id };
                  }
                  return null;
                }
                return null;
              }),
              all: vi.fn().mockImplementation(async () => {
                if (sql.includes('FROM identity_sensitive_values')) {
                  return { results: [] };
                }
                // Handle bulk SELECT for PII data
                if (sql.includes('SELECT') && sql.includes('FROM users_pii WHERE id IN')) {
                  const results = args
                    .map((id: string) => {
                      const user = mockUsers.get(id);
                      if (!user) return null;
                      return {
                        id: user.id,
                        email: user.email,
                        name: user.name,
                        given_name: user.given_name,
                        family_name: user.family_name,
                        middle_name: null,
                        nickname: null,
                        preferred_username: user.preferred_username,
                        custom_attributes_json: user.custom_attributes_json || null,
                      };
                    })
                    .filter(Boolean);
                  return { results };
                }
                return { results: [] };
              }),
              run: vi.fn().mockImplementation(async () => {
                if (sql.includes('INSERT INTO identity_sensitive_values')) {
                  const userId = args[3];
                  const valueKey = args[4];
                  const user = mockUsers.get(userId);
                  if (user) {
                    user[valueKey] = JSON.parse(args[5]);
                  }
                  return { success: true };
                }
                if (sql.includes('UPDATE identity_sensitive_values SET lifecycle_state')) {
                  const userId = args[3];
                  if (!args[4]) {
                    const user = mockUsers.get(userId);
                    if (user && args[0] !== 'active') {
                      user.active = 0;
                    }
                  }
                  return { success: true };
                }
                // Handle INSERT/UPDATE/DELETE for PII
                if (sql.includes('INSERT INTO users_pii')) {
                  // bind() order for INSERT INTO users_pii:
                  // id, tenant_id, pii_class, email, email_blind_index, phone_number,
                  // name, given_name, family_name, nickname, preferred_username,
                  // picture, website, gender, birthdate, locale, zoneinfo,
                  // address_formatted, address_street_address, address_locality,
                  // address_region, address_postal_code, address_country,
                  // declared_residence, created_at, updated_at
                  const userId = args[0];
                  const user = mockUsers.get(userId);
                  if (user) {
                    // Update existing user with PII data
                    user.email = args[3];
                    user.name = args[6];
                    user.given_name = args[7];
                    user.family_name = args[8];
                    user.nickname = args[9];
                    user.preferred_username = args[10];
                    user.picture = args[11];
                    user.website = args[12];
                    user.locale = args[15];
                    user.zoneinfo = args[16];
                  }
                  return { success: true };
                }
                if (sql.includes('UPDATE users_pii SET')) {
                  if (sql.includes('custom_attributes_json = ?')) {
                    const userId = args[2];
                    const user = mockUsers.get(userId);
                    if (user) {
                      user.custom_attributes_json = args[0];
                    }
                    return { success: true };
                  }
                  // PII update - update mockUsers with new PII
                  const userId = args[args.length - 1];
                  const user = mockUsers.get(userId);
                  if (user) {
                    user.email = args[0];
                    user.name = args[1];
                    user.given_name = args[2];
                    user.family_name = args[3];
                    user.preferred_username = args[7];
                  }
                  return { success: true };
                }
                if (sql.includes('DELETE FROM users_pii')) {
                  // PII delete
                  return { success: true };
                }
                if (sql.includes('INSERT INTO users_pii_tombstone')) {
                  // Tombstone insert for GDPR
                  return { success: true };
                }
                return { success: true };
              }),
            })),
          };
        }),
        batch: vi.fn(async (statements: Array<{ run: () => Promise<unknown> }>) =>
          Promise.all(statements.map((statement) => statement.run()))
        ),
      } as any,
      INITIAL_ACCESS_TOKENS: {
        get: vi.fn().mockResolvedValue(JSON.stringify({ enabled: true })),
      } as any,
      SESSION_REVOCATION_STORE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({
          getAccountStateRpc: vi.fn(async (_tenant, _user, account) => {
            const state = sessionRevocationStates.get(account);
            return {
              lifecycle: state?.lifecycle ?? null,
              lifecycleVersionMs: state?.lifecycleVersionMs ?? null,
            };
          }),
          setAccountLifecycleRpc: vi.fn(
            async (_tenant, _user, account, lifecycle, lifecycleVersionMs) => {
              sessionRevocationStates.set(account, { lifecycle, lifecycleVersionMs });
              return { lifecycle, lifecycleVersionMs };
            }
          ),
        })),
      } as any,
    };

    // Create Hono app with mock environment binding
    app = new Hono();
    app.route('/scim/v2', scimApp);
  });

  // Helper to create request with proper headers
  function createRequest(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers || {});
    if (!headers.has('Authorization')) {
      headers.set('Authorization', 'Bearer valid-scim-token');
    }
    if (!headers.has('Content-Type') && options.body) {
      headers.set('Content-Type', 'application/scim+json');
    }
    return new Request(`http://localhost${path}`, {
      ...options,
      headers,
    });
  }

  describe('Authentication', () => {
    it('should advertise that SCIM password changes are not supported', async () => {
      const req = new Request('http://localhost/scim/v2/ServiceProviderConfig');
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.changePassword).toEqual({ supported: false });
    });

    it('should reject request without Authorization header', async () => {
      const req = new Request('http://localhost/scim/v2/Users', {
        headers: { 'Content-Type': 'application/json' },
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(401);
      const body = (await res.json()) as any;
      expect(body.detail).toContain('No authorization header');
    });

    it('does not treat reserved-looking user IDs as discovery routes', async () => {
      for (const id of ['Schemas', 'ResourceTypes', 'ServiceProviderConfig']) {
        const res = await app.fetch(
          new Request(`http://localhost/scim/v2/Users/${id}`),
          mockEnv as Env
        );
        expect(res.status).toBe(401);
      }
    });

    it('only exempts GET requests to SCIM discovery routes', async () => {
      const res = await app.fetch(
        new Request('http://localhost/scim/v2/Schemas', { method: 'DELETE' }),
        mockEnv as Env
      );
      expect(res.status).toBe(401);
    });

    it('should reject request with non-Bearer token', async () => {
      const req = new Request('http://localhost/scim/v2/Users', {
        headers: {
          Authorization: 'Basic dXNlcjpwYXNz',
          'Content-Type': 'application/json',
        },
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(401);
      const body = (await res.json()) as any;
      expect(body.detail).toContain('Invalid authorization header format');
    });

    it('should reject expired SCIM token', async () => {
      const req = new Request('http://localhost/scim/v2/Users', {
        headers: {
          Authorization: 'Bearer expired-token',
          'Content-Type': 'application/json',
        },
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(401);
      const body = (await res.json()) as any;
      expect(body.detail).toContain('expired');
    });

    it('should reject invalid SCIM token', async () => {
      const req = new Request('http://localhost/scim/v2/Users', {
        headers: {
          Authorization: 'Bearer invalid-token',
          'Content-Type': 'application/json',
        },
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(401);
      const body = (await res.json()) as any;
      expect(body.detail).toContain('Invalid');
    });

    it('should accept valid SCIM token', async () => {
      const req = createRequest('/scim/v2/Users');
      const res = await app.fetch(req, mockEnv as Env);

      // Should not be 401/403
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    });

    it('should fail closed without tenant context in multi-tenant mode', async () => {
      const req = createRequest('/scim/v2/Users');
      const res = await app.fetch(req, { ...mockEnv, BASE_DOMAIN: 'example.com' } as Env);

      expect(res.status).toBe(403);
      const body = (await res.json()) as any;
      expect(body.detail).toBe('Tenant context is required');
    });
  });

  describe('GET /scim/v2/Users - List Users', () => {
    it('should return list of users with pagination', async () => {
      const req = createRequest('/scim/v2/Users');
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:ListResponse');
      expect(body.totalResults).toBeGreaterThanOrEqual(0);
      expect(body.startIndex).toBe(1);
      expect(body.Resources).toBeDefined();
    });

    it('should support startIndex and count pagination parameters', async () => {
      const req = createRequest('/scim/v2/Users?startIndex=1&count=10');
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.startIndex).toBe(1);
      expect(body.itemsPerPage).toBeLessThanOrEqual(10);
    });

    it('returns no resources for count=0 while preserving totalResults', async () => {
      const res = await app.fetch(createRequest('/scim/v2/Users?count=0'), mockEnv as Env);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        totalResults: 2,
        itemsPerPage: 0,
        Resources: [],
      });
    });

    it.each(['startIndex=0', 'count=-1', 'count=1x', 'sortOrder=sideways'])(
      'rejects invalid pagination parameter %s',
      async (query) => {
        const res = await app.fetch(createRequest(`/scim/v2/Users?${query}`), mockEnv as Env);
        expect(res.status).toBe(400);
      }
    );

    it('should limit count to maximum allowed', async () => {
      const req = createRequest('/scim/v2/Users?count=5000');
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // Max is 1000
      expect(body.itemsPerPage).toBeLessThanOrEqual(1000);
    });

    it('should support filter parameter', async () => {
      const req = createRequest('/scim/v2/Users?filter=userName%20eq%20%22johndoe%22');
      const res = await app.fetch(req, mockEnv as Env);

      // Filter parsing might fail or succeed depending on implementation
      // Important: should not return 500
      expect(res.status).not.toBe(500);
    });

    it('should reject invalid filter syntax', async () => {
      const req = createRequest('/scim/v2/Users?filter=invalid_syntax!!!');
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.scimType).toBe('invalidFilter');
    });

    it.each([
      'unknownAttribute%20eq%20%22value%22',
      'emails%5Btype%20eq%20%22work%22%5D.value%20eq%20%22john.doe%40example.com%22',
    ])('rejects unsupported filter %s consistently', async (filter) => {
      const res = await app.fetch(createRequest(`/scim/v2/Users?filter=${filter}`), mockEnv as Env);

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ scimType: 'invalidFilter' });
    });

    it('fails closed when a routed account PII binding is unavailable', async () => {
      delete (mockEnv as Partial<Record<keyof Env, unknown>>).DB_PII;

      const res = await app.fetch(createRequest('/scim/v2/Users'), mockEnv as Env);

      expect(res.status).toBe(500);
      await expect(res.json()).resolves.toMatchObject({
        detail: 'Internal server error',
      });
    });
  });

  describe('GET /scim/v2/Users/:id - Get User', () => {
    it('should return user by ID', async () => {
      const req = createRequest('/scim/v2/Users/user-001');
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.schemas).toContain('urn:ietf:params:scim:schemas:core:2.0:User');
      expect(body.id).toBe('user-001');
      expect(body.userName).toBeDefined();
    });

    it('keeps an inactive user readable for later reactivation', async () => {
      mockUsers.get('user-001').active = 0;
      mockUsers.get('user-001').lifecycle_state = 'deprovisioned';

      const res = await app.fetch(createRequest('/scim/v2/Users/user-001'), mockEnv as Env);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ id: 'user-001', active: false });
    });

    it('should include enterprise extension when custom attributes exist', async () => {
      mockUsers.get('user-001').custom_attributes_json = JSON.stringify({
        department: 'Engineering',
      });

      const req = createRequest('/scim/v2/Users/user-001');
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.schemas).toContain('urn:ietf:params:scim:schemas:extension:enterprise:2.0:User');
      expect(body['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User']?.department).toBe(
        'Engineering'
      );
    });

    it('returns direct group memberships for the user', async () => {
      mockUserRoles.set('group-001', [{ user_id: 'user-001', email: 'john.doe@example.com' }]);

      const res = await app.fetch(createRequest('/scim/v2/Users/user-001'), mockEnv as Env);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        groups: [
          {
            value: 'group-001',
            display: 'Administrators',
            type: 'direct',
            $ref: expect.stringContaining('/scim/v2/Groups/group-001'),
          },
        ],
      });
    });

    it('projects requested attributes while preserving always-returned fields', async () => {
      const res = await app.fetch(
        createRequest('/scim/v2/Users/user-001?attributes=userName,name.givenName'),
        mockEnv as Env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body).toMatchObject({
        id: 'user-001',
        userName: expect.any(String),
        name: { givenName: expect.any(String) },
        schemas: expect.any(Array),
        meta: expect.any(Object),
      });
      expect(body.emails).toBeUndefined();
      expect(body.active).toBeUndefined();
    });

    it('rejects attributes together with excludedAttributes', async () => {
      const res = await app.fetch(
        createRequest('/scim/v2/Users/user-001?attributes=userName&excludedAttributes=emails'),
        mockEnv as Env
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ scimType: 'invalidValue' });
    });

    it('preserves always-returned fields when excludedAttributes requests them', async () => {
      const res = await app.fetch(
        createRequest('/scim/v2/Users/user-001?excludedAttributes=id,schemas,meta,emails'),
        mockEnv as Env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body).toMatchObject({
        id: 'user-001',
        schemas: expect.any(Array),
        meta: expect.any(Object),
      });
      expect(body.emails).toBeUndefined();
    });

    it('should return 404 for non-existent user', async () => {
      const req = createRequest('/scim/v2/Users/non-existent-user');
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.detail).toContain('not found');
    });

    it('fails closed on stale account routing without using tenant metadata fallback', async () => {
      accountRoutingState.error = new Error('account_data_binding_generation_stale');

      const res = await app.fetch(createRequest('/scim/v2/Users/user-001'), mockEnv as Env);

      expect(res.status).toBe(500);
      expect(accountRoutingState.calls).toEqual(['user-001']);
      await expect(res.json()).resolves.toMatchObject({ detail: 'Internal server error' });
    });

    it('should return 304 Not Modified when ETag matches', async () => {
      // First get the user to obtain ETag
      const req1 = createRequest('/scim/v2/Users/user-001');
      const res1 = await app.fetch(req1, mockEnv as Env);
      const etag = res1.headers.get('ETag');

      if (etag) {
        // Request with If-None-Match header
        const req2 = createRequest('/scim/v2/Users/user-001', {
          headers: {
            Authorization: 'Bearer valid-scim-token',
            'If-None-Match': etag,
          },
        });
        const res2 = await app.fetch(req2, mockEnv as Env);

        expect(res2.status).toBe(304);
      }
    });
  });

  describe('POST /scim/v2/Users - Create User', () => {
    it('should create new user', async () => {
      const newUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'newuser',
        name: {
          givenName: 'New',
          familyName: 'User',
        },
        emails: [{ value: 'new.user@example.com', primary: true }],
        active: true,
      };

      const req = createRequest('/scim/v2/Users', {
        method: 'POST',
        body: JSON.stringify(newUser),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;

      expect(body.id).toBeDefined();
      expect(body.userName).toBe('newuser');
      expect(res.headers.get('Location')).toBeDefined();
      expect(accountCreationState.calls).toHaveLength(1);
      expect(accountCreationState.calls[0]).toMatchObject({
        tenantId: 'default',
        residencyPolicyId: 'builtin:residency:default',
        residencyPartition: 'default',
        email: 'new.user@example.com',
      });
      expect(accountCreationState.calls[0]?.actorId).toMatch(/^scim-token:[a-f0-9]{64}$/u);
      expect(accountCreationState.calls[0]?.actorId).not.toContain('valid-scim-token');
    });

    it('returns an operation resource when directory publication continues asynchronously', async () => {
      accountCreationState.deliveryStatus = 202;
      const req = createRequest('/scim/v2/Users', {
        method: 'POST',
        headers: { 'Idempotency-Key': 'scim-create-pending-1' },
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'pending-user',
          emails: [{ value: 'pending.user@example.com', primary: true }],
          active: true,
        }),
      });

      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(202);
      const body = (await res.json()) as any;
      expect(body.schemas).toEqual([
        'urn:authrim:params:scim:api:messages:2.0:AccountCreationOperation',
      ]);
      expect(body.status).toBe('directory_pending');
      expect(body.operationId).toBeDefined();
      expect(res.headers.get('Location')).toBe(
        `http://localhost/scim/v2/Operations/${body.operationId}`
      );
      expect(accountCreationState.calls[0]?.idempotencyKey).toBe('scim-create-pending-1');
    });

    it('rejects an unsafe explicit idempotency key before provisioning', async () => {
      const req = createRequest('/scim/v2/Users', {
        method: 'POST',
        headers: { 'Idempotency-Key': 'short' },
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'unsafe-key-user',
          emails: [{ value: 'unsafe.key@example.com', primary: true }],
        }),
      });

      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(400);
      expect(accountCreationState.calls).toHaveLength(0);
    });

    it('returns a retryable SCIM error when no account shard has capacity', async () => {
      accountCreationState.capacityUnavailable = true;
      const req = createRequest('/scim/v2/Users', {
        method: 'POST',
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'capacity-user',
          emails: [{ value: 'capacity.user@example.com', primary: true }],
        }),
      });

      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(503);
      const body = (await res.json()) as any;
      expect(body.status).toBe('503');
      expect(body.detail).not.toContain('capacity.user@example.com');
    });

    it('returns a retryable SCIM error while a runtime binding is propagating', async () => {
      accountCreationState.bindingUnavailable = true;
      const req = createRequest('/scim/v2/Users', {
        method: 'POST',
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'binding-user',
          emails: [{ value: 'binding.user@example.com', primary: true }],
        }),
      });

      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('1');
      await expect(res.json()).resolves.toMatchObject({
        status: '503',
        detail: 'Runtime database binding is propagating; retry shortly',
      });
    });

    it('returns a retryable SCIM error while the lookup registry generation is propagating', async () => {
      accountCreationState.registryGenerationPropagating = true;
      const req = createRequest('/scim/v2/Users', {
        method: 'POST',
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'lookup-registry-user',
          emails: [{ value: 'lookup.registry@example.com', primary: true }],
        }),
      });

      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('1');
      await expect(res.json()).resolves.toMatchObject({
        status: '503',
        detail: 'Runtime lookup registry generation is propagating; retry shortly',
      });
    });

    it('publishes normalized userName in the tenant-scoped SCIM subject namespace', async () => {
      const req = createRequest('/scim/v2/Users', {
        method: 'POST',
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          externalId: 'provider-user-42',
          userName: 'External-User',
          emails: [{ value: 'external.user@example.com', primary: true }],
        }),
      });

      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(201);
      expect(accountCreationState.calls[0]?.externalSubject).toEqual({
        issuer: 'urn:authrim:scim:default:username',
        subject: 'external-user',
      });
    });

    it.each(['johndoe', 'JohnDoe'])(
      'rejects tenant-wide duplicate userName %s case-insensitively',
      async (userName) => {
        const res = await app.fetch(
          createRequest('/scim/v2/Users', {
            method: 'POST',
            body: JSON.stringify({
              schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
              userName,
              emails: [{ value: `${userName.toLowerCase()}-duplicate@example.com`, primary: true }],
            }),
          }),
          mockEnv as Env
        );

        expect(res.status).toBe(409);
        await expect(res.json()).resolves.toMatchObject({ scimType: 'uniqueness' });
        expect(accountCreationState.calls).toHaveLength(1);
      }
    );

    it('allows duplicate externalId values', async () => {
      const res = await app.fetch(
        createRequest('/scim/v2/Users', {
          method: 'POST',
          body: JSON.stringify({
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
            externalId: 'ext-001',
            userName: 'external-id-is-not-unique',
            emails: [{ value: 'external.id.not.unique@example.com', primary: true }],
          }),
        }),
        mockEnv as Env
      );

      expect(res.status).toBe(201);
    });

    it.each([
      [{ userName: 'missing-schemas' }, 'schemas'],
      [{ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: '   ' }, 'userName'],
      [
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'bad-email',
          emails: [{ value: 'not-an-email' }],
        },
        'emails[0].value',
      ],
      [
        {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'bad-emails-shape',
          emails: 'not-an-array',
        },
        'emails',
      ],
    ])('rejects invalid user input with a SCIM 400 error', async (body, detail) => {
      const res = await app.fetch(
        createRequest('/scim/v2/Users', { method: 'POST', body: JSON.stringify(body) }),
        mockEnv as Env
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({
        status: '400',
        detail: expect.stringContaining(detail),
      });
    });

    it('rejects malformed JSON with invalidSyntax instead of returning 500', async () => {
      const res = await app.fetch(
        createRequest('/scim/v2/Users', { method: 'POST', body: '{"schemas":[' }),
        mockEnv as Env
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ scimType: 'invalidSyntax' });
    });

    it('should reject SCIM password provisioning without storing a password hash', async () => {
      const newUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'password-user',
        emails: [{ value: 'password.user@example.com', primary: true }],
        password: 'not-stored',
        active: true,
      };

      const req = createRequest('/scim/v2/Users', {
        method: 'POST',
        body: JSON.stringify(newUser),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.scimType).toBe('invalidValue');
      expect(body.detail).toContain('SCIM password provisioning is not supported');
      expect([...mockUsers.values()]).not.toContainEqual(
        expect.objectContaining({ email: 'password.user@example.com' })
      );
    });

    it('should reject duplicate email', async () => {
      const newUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'duplicate',
        emails: [{ value: 'john.doe@example.com', primary: true }], // Already exists
        active: true,
      };

      const req = createRequest('/scim/v2/Users', {
        method: 'POST',
        body: JSON.stringify(newUser),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(409);
      const body = (await res.json()) as any;
      expect(body.scimType).toBe('uniqueness');
    });

    it('should validate required fields', async () => {
      const invalidUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        // Missing userName
      };

      const req = createRequest('/scim/v2/Users', {
        method: 'POST',
        body: JSON.stringify(invalidUser),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.scimType).toBe('invalidValue');
    });

    it('should enforce required custom claim fields on create', async () => {
      mockCustomClaimSchemas = [createCustomClaimSchemaRow()];

      const newUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'missing-department',
        emails: [{ value: 'missing.department@example.com', primary: true }],
        active: true,
      };

      const req = createRequest('/scim/v2/Users', {
        method: 'POST',
        body: JSON.stringify(newUser),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.detail).toContain('Department is required');
      expect(body.scimType).toBe('invalidValue');
      expect(body.missing_required_fields).toEqual([
        {
          field_key: 'department',
          label: 'Department',
          field_type: 'string',
        },
      ]);
    });

    it('should persist enterprise extension custom attributes', async () => {
      mockCustomClaimSchemas = [createCustomClaimSchemaRow({ is_required: 0 })];

      const newUser = {
        schemas: [
          'urn:ietf:params:scim:schemas:core:2.0:User',
          'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
        ],
        userName: 'newuser',
        emails: [{ value: 'new.enterprise@example.com', primary: true }],
        active: true,
        'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
          department: 'Support',
        },
      };

      const req = createRequest('/scim/v2/Users', {
        method: 'POST',
        body: JSON.stringify(newUser),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User']?.department).toBe(
        'Support'
      );
    });

    it('should create a user when a required non-PII enterprise field is satisfied', async () => {
      mockCustomClaimSchemas = [createCustomClaimSchemaRow({ is_pii: 0, is_required: 1 })];

      const newUser = {
        schemas: [
          'urn:ietf:params:scim:schemas:core:2.0:User',
          'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
        ],
        userName: 'required-non-pii-user',
        emails: [{ value: 'required.nonpii@example.com', primary: true }],
        active: true,
        'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
          department: 'Platform',
        },
      };

      const req = createRequest('/scim/v2/Users', {
        method: 'POST',
        body: JSON.stringify(newUser),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.userName).toBe('required-non-pii-user');
    });
  });

  describe('GET /scim/v2/Operations/:id - Account Creation Status', () => {
    it('returns the current state and completed resource location', async () => {
      accountOperationState.operation = {
        operationId: 'operation-account-a',
        tenantId: 'default',
        actorId: `scim-token:${'a'.repeat(64)}`,
        userId: 'user-created-a',
        status: 'succeeded',
      };

      const res = await app.fetch(
        createRequest('/scim/v2/Operations/operation-account-a'),
        mockEnv as Env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.status).toBe('succeeded');
      expect(body.userId).toBe('user-created-a');
      expect(body.resourceLocation).toBe('http://localhost/scim/v2/Users/user-created-a');
    });

    it('does not disclose an unavailable operation', async () => {
      const res = await app.fetch(
        createRequest('/scim/v2/Operations/operation-unknown'),
        mockEnv as Env
      );

      expect(res.status).toBe(404);
      const body = (await res.json()) as any;
      expect(body.detail).toBe('The requested resource was not found');
    });

    it('reports backend failures without presenting them as an unknown operation', async () => {
      accountOperationState.error = new Error('simulated_database_unavailable');

      const res = await app.fetch(
        createRequest('/scim/v2/Operations/operation-account-a'),
        mockEnv as Env
      );

      expect(res.status).toBe(500);
      const body = (await res.json()) as any;
      expect(body.detail).toBe('Internal server error');
    });
  });

  describe('PUT /scim/v2/Users/:id - Replace User', () => {
    it('should replace user completely', async () => {
      const updatedUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'johndoe_updated',
        name: {
          givenName: 'John',
          familyName: 'Updated',
        },
        emails: [{ value: 'john.updated@example.com', primary: true }],
        active: true,
      };

      const req = createRequest('/scim/v2/Users/user-001', {
        method: 'PUT',
        body: JSON.stringify(updatedUser),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // userName comes from DB after update, verify response structure
      expect(body.schemas).toContain('urn:ietf:params:scim:schemas:core:2.0:User');
      expect(body.id).toBe('user-001');
    });

    it('replaces an inactive user', async () => {
      mockUsers.get('user-001').active = 0;
      mockUsers.get('user-001').lifecycle_state = 'deprovisioned';
      customClaimRoutingState.rejectAccountLookup = true;

      const res = await app.fetch(
        createRequest('/scim/v2/Users/user-001', {
          method: 'PUT',
          body: JSON.stringify({
            schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
            userName: 'johndoe',
            emails: [{ value: 'john.doe@example.com', primary: true }],
            active: true,
          }),
        }),
        mockEnv as Env
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ active: true });
    });

    it('should reject SCIM password on replace without changing an existing password hash', async () => {
      mockUsers.get('user-001').password_hash = 'legacy-hash';
      const updatedUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'johndoe',
        emails: [{ value: 'john.doe@example.com', primary: true }],
        password: 'not-stored',
        active: true,
      };

      const req = createRequest('/scim/v2/Users/user-001', {
        method: 'PUT',
        body: JSON.stringify(updatedUser),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.detail).toContain('SCIM password provisioning is not supported');
      expect(mockUsers.get('user-001').password_hash).toBe('legacy-hash');
    });

    it('should return 404 for non-existent user', async () => {
      const req = createRequest('/scim/v2/Users/non-existent', {
        method: 'PUT',
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'test',
          emails: [{ value: 'test@example.com', primary: true }],
        }),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(404);
    });

    it('should enforce ETag with If-Match header', async () => {
      // Get user to obtain current ETag
      const req1 = createRequest('/scim/v2/Users/user-001');
      const res1 = await app.fetch(req1, mockEnv as Env);
      const body1 = await res1.json();

      // Use mismatched ETag
      const req2 = createRequest('/scim/v2/Users/user-001', {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer valid-scim-token',
          'If-Match': '"wrong-etag"',
        },
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'test',
          emails: [{ value: 'test@example.com', primary: true }],
        }),
      });
      const res2 = await app.fetch(req2, mockEnv as Env);

      expect(res2.status).toBe(412);
      const body2 = (await res2.json()) as any;
      expect(body2.scimType).toBe('invalidVers');
    });

    it('should reject replace when required custom claim would be removed', async () => {
      mockCustomClaimSchemas = [createCustomClaimSchemaRow()];
      mockUsers.get('user-001').custom_attributes_json = JSON.stringify({
        department: 'Engineering',
      });

      const updatedUser = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'johndoe',
        emails: [{ value: 'john.doe@example.com', primary: true }],
        active: true,
      };

      const req = createRequest('/scim/v2/Users/user-001', {
        method: 'PUT',
        body: JSON.stringify(updatedUser),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.detail).toContain('Department is required');
      expect(body.scimType).toBe('invalidValue');
      expect(body.missing_required_fields).toEqual([
        {
          field_key: 'department',
          label: 'Department',
          field_type: 'string',
        },
      ]);
    });
  });

  describe('PATCH /scim/v2/Users/:id - Partial Update', () => {
    it('should apply patch operation names case-insensitively', async () => {
      const patchOp = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'Replace', path: 'active', value: false }],
      };

      const req = createRequest('/scim/v2/Users/user-001', {
        method: 'PATCH',
        body: JSON.stringify(patchOp),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      // Verify response structure - the actual active value depends on mock implementation
      expect(body.schemas).toContain('urn:ietf:params:scim:schemas:core:2.0:User');
      expect(body.id).toBe('user-001');
      const namespace = mockEnv.SESSION_REVOCATION_STORE as any;
      expect(namespace.get).toHaveBeenCalledOnce();
      expect(namespace.get.mock.results[0].value.setAccountLifecycleRpc.mock.calls[0][3]).toBe(
        'inactive'
      );
    });

    it('reactivates an inactive user', async () => {
      mockUsers.get('user-001').active = 0;
      mockUsers.get('user-001').lifecycle_state = 'deprovisioned';
      customClaimRoutingState.rejectAccountLookup = true;

      const res = await app.fetch(
        createRequest('/scim/v2/Users/user-001', {
          method: 'PATCH',
          body: JSON.stringify({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
            Operations: [{ op: 'replace', path: 'active', value: true }],
          }),
        }),
        mockEnv as Env
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ active: true });
    });

    it.each([
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      },
      {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'move', path: 'active', value: true }],
      },
    ])('rejects malformed or unsupported patch operations', async (patchOp) => {
      const res = await app.fetch(
        createRequest('/scim/v2/Users/user-001', {
          method: 'PATCH',
          body: JSON.stringify(patchOp),
        }),
        mockEnv as Env
      );

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ scimType: 'invalidSyntax' });
    });

    it('should reject SCIM password on patch without changing an existing password hash', async () => {
      mockUsers.get('user-001').password_hash = 'legacy-hash';
      const patchOp = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'password', value: 'not-stored' }],
      };

      const req = createRequest('/scim/v2/Users/user-001', {
        method: 'PATCH',
        body: JSON.stringify(patchOp),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.detail).toContain('SCIM password provisioning is not supported');
      expect(mockUsers.get('user-001').password_hash).toBe('legacy-hash');
    });

    it('should preserve existing required custom claim values during patch', async () => {
      mockCustomClaimSchemas = [createCustomClaimSchemaRow()];
      mockUsers.get('user-001').custom_attributes_json = JSON.stringify({
        department: 'Engineering',
      });

      const patchOp = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      };

      const req = createRequest('/scim/v2/Users/user-001', {
        method: 'PATCH',
        body: JSON.stringify(patchOp),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User']?.department).toBe(
        'Engineering'
      );
    });

    it('should return 404 for non-existent user', async () => {
      const patchOp = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
        Operations: [{ op: 'replace', path: 'active', value: false }],
      };

      const req = createRequest('/scim/v2/Users/non-existent', {
        method: 'PATCH',
        body: JSON.stringify(patchOp),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /scim/v2/Users/:id - Delete User', () => {
    it('blocks deletion when the account has an active legal hold', async () => {
      activeLegalHolds.set('user-001', 'legal-hold:scim-held');
      const res = await app.fetch(
        createRequest('/scim/v2/Users/user-001', { method: 'DELETE' }),
        mockEnv as Env
      );

      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({
        status: '409',
        detail: 'User is under legal hold and cannot be deleted',
      });
      expect(accountRemovalState.prepare).not.toHaveBeenCalled();
      expect(mockUsers.get('user-001')).toMatchObject({ active: 1 });
    });

    it('should delete user', async () => {
      const req = createRequest('/scim/v2/Users/user-001', {
        method: 'DELETE',
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(204);
      const namespace = mockEnv.SESSION_REVOCATION_STORE as any;
      expect(namespace.get).toHaveBeenCalledTimes(2);
      expect(
        namespace.get.mock.results.map(
          (result: { value: { setAccountLifecycleRpc: ReturnType<typeof vi.fn> } }) =>
            result.value.setAccountLifecycleRpc.mock.calls[0][3]
        )
      ).toEqual(['deleting', 'deleted']);

      const getAfterDelete = await app.fetch(
        createRequest('/scim/v2/Users/user-001'),
        mockEnv as Env
      );
      expect(getAfterDelete.status).toBe(404);
    });

    it('should delete a user after SCIM deactivation', async () => {
      const deactivate = createRequest('/scim/v2/Users/user-001', {
        method: 'PATCH',
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
          Operations: [{ op: 'Replace', path: 'active', value: false }],
        }),
      });
      expect((await app.fetch(deactivate, mockEnv as Env)).status).toBe(200);

      const remove = createRequest('/scim/v2/Users/user-001', {
        method: 'DELETE',
      });
      expect((await app.fetch(remove, mockEnv as Env)).status).toBe(204);
    });

    it('should return 404 for non-existent user', async () => {
      const req = createRequest('/scim/v2/Users/non-existent', {
        method: 'DELETE',
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(404);
    });

    it('should enforce ETag with If-Match header', async () => {
      const req = createRequest('/scim/v2/Users/user-001', {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer valid-scim-token',
          'If-Match': '"wrong-etag"',
        },
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(412);
    });
  });

  describe('GET /scim/v2/Groups - List Groups', () => {
    it('should return list of groups', async () => {
      const req = createRequest('/scim/v2/Groups');
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:ListResponse');
      expect(body.Resources).toBeDefined();
    });

    it('supports count=0 and validates pagination like the Users endpoint', async () => {
      const zero = await app.fetch(createRequest('/scim/v2/Groups?count=0'), mockEnv as Env);
      expect(zero.status).toBe(200);
      await expect(zero.json()).resolves.toMatchObject({ itemsPerPage: 0, Resources: [] });

      const invalid = await app.fetch(
        createRequest('/scim/v2/Groups?startIndex=0'),
        mockEnv as Env
      );
      expect(invalid.status).toBe(400);
    });
  });

  describe('POST /scim/v2/Groups - Create Group', () => {
    it('should create new group', async () => {
      const newGroup = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'New Group',
        members: [],
      };

      const req = createRequest('/scim/v2/Groups', {
        method: 'POST',
        body: JSON.stringify(newGroup),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      expect(body.displayName).toBe('New Group');
    });

    it('should reject duplicate group name', async () => {
      const newGroup = {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
        displayName: 'Administrators', // Already exists
      };

      const req = createRequest('/scim/v2/Groups', {
        method: 'POST',
        body: JSON.stringify(newGroup),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(409);
      const body = (await res.json()) as any;
      expect(body.scimType).toBe('uniqueness');
    });
  });

  describe('SCIM Error Response Format', () => {
    it('should return RFC 7644 compliant error response', async () => {
      const req = createRequest('/scim/v2/Users/non-existent');
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(404);
      const body = (await res.json()) as any;

      expect(body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:Error');
      expect(body.status).toBeDefined();
      expect(body.detail).toBeDefined();
    });
  });

  describe('SCIM Bulk Operations (RFC 7644 Section 3.7)', () => {
    it('blocks a bulk user deletion when the account has an active legal hold', async () => {
      activeLegalHolds.set('user-001', 'legal-hold:scim-bulk-held');
      const res = await app.fetch(
        createRequest('/scim/v2/Bulk', {
          method: 'POST',
          body: JSON.stringify({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
            Operations: [{ method: 'DELETE', path: '/Users/user-001' }],
          }),
        }),
        mockEnv as Env
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        Operations: [
          {
            method: 'DELETE',
            status: '409',
            response: {
              status: '409',
              detail: 'User is under legal hold and cannot be deleted',
            },
          },
        ],
      });
      expect(accountRemovalState.prepare).not.toHaveBeenCalled();
      expect(mockUsers.get('user-001')).toMatchObject({ active: 1 });
    });

    it('processes independent user creates concurrently when failOnErrors is zero', async () => {
      accountCreationState.pause = () => new Promise((resolve) => setTimeout(resolve, 20));
      const operations = Array.from({ length: 4 }, (_, index) => ({
        method: 'POST',
        path: '/Users',
        bulkId: `parallel-user-${index}`,
        data: {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: `parallel-user-${index}`,
          emails: [{ value: `parallel-user-${index}@example.com`, primary: true }],
        },
      }));

      const res = await app.fetch(
        createRequest('/scim/v2/Bulk', {
          method: 'POST',
          body: JSON.stringify({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
            failOnErrors: 0,
            Operations: operations,
          }),
        }),
        mockEnv as Env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.Operations.map((operation: any) => operation.bulkId)).toEqual(
        operations.map((operation) => operation.bulkId)
      );
      expect(body.Operations.every((operation: any) => operation.status === '201')).toBe(true);
      expect(accountCreationState.maxInFlight).toBe(4);
    });

    it('keeps failOnErrors processing sequential and stops at the requested limit', async () => {
      const res = await app.fetch(
        createRequest('/scim/v2/Bulk', {
          method: 'POST',
          body: JSON.stringify({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
            failOnErrors: 1,
            Operations: [
              {
                method: 'POST',
                path: '/Users',
                bulkId: 'invalid-first',
                data: { userName: 'invalid-first' },
              },
              {
                method: 'POST',
                path: '/Users',
                bulkId: 'must-not-run',
                data: {
                  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
                  userName: 'must-not-run',
                  emails: [{ value: 'must-not-run@example.com', primary: true }],
                },
              },
            ],
          }),
        }),
        mockEnv as Env
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.Operations).toHaveLength(1);
      expect(body.Operations[0]).toMatchObject({ bulkId: 'invalid-first', status: '400' });
      expect(accountCreationState.calls).toHaveLength(0);
    });

    it('should process bulk POST operations', async () => {
      const bulkRequest = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          {
            method: 'POST',
            path: '/Users',
            bulkId: 'user1',
            data: {
              schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
              userName: 'newuser1@example.com',
              name: { givenName: 'New', familyName: 'User1' },
              emails: [{ value: 'newuser1@example.com', primary: true }],
            },
          },
        ],
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.schemas).toContain('urn:ietf:params:scim:api:messages:2.0:BulkResponse');
      expect(body.Operations).toBeDefined();
      expect(body.Operations.length).toBe(1);
      expect(body.Operations[0].status).toBe('201');
      expect(body.Operations[0].bulkId).toBe('user1');
      expect(body.Operations[0].location).toBeDefined();
    });

    it('returns a retryable per-operation error while a runtime binding is propagating', async () => {
      accountCreationState.bindingUnavailable = true;
      const res = await app.fetch(
        createRequest('/scim/v2/Bulk', {
          method: 'POST',
          body: JSON.stringify({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
            Operations: [
              {
                method: 'POST',
                path: '/Users',
                bulkId: 'binding-propagating-user',
                data: {
                  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
                  userName: 'binding-propagating-user',
                  emails: [{ value: 'binding-propagating@example.com', primary: true }],
                },
              },
            ],
          }),
        }),
        mockEnv as Env
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        Operations: [
          {
            bulkId: 'binding-propagating-user',
            status: '503',
            response: {
              status: '503',
              detail: 'Runtime database binding is propagating; retry shortly',
            },
          },
        ],
      });
    });

    it('returns a retryable per-operation error while lookup registry generation propagates', async () => {
      accountCreationState.registryGenerationPropagating = true;
      const res = await app.fetch(
        createRequest('/scim/v2/Bulk', {
          method: 'POST',
          body: JSON.stringify({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
            Operations: [
              {
                method: 'POST',
                path: '/Users',
                bulkId: 'lookup-registry-propagating-user',
                data: {
                  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
                  userName: 'lookup-registry-propagating-user',
                  emails: [{ value: 'lookup-registry-propagating@example.com', primary: true }],
                },
              },
            ],
          }),
        }),
        mockEnv as Env
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        Operations: [
          {
            bulkId: 'lookup-registry-propagating-user',
            status: '503',
            response: {
              status: '503',
              detail: 'Runtime lookup registry generation is propagating; retry shortly',
            },
          },
        ],
      });
    });

    it('returns per-operation 400 errors for missing resource schemas', async () => {
      const res = await app.fetch(
        createRequest('/scim/v2/Bulk', {
          method: 'POST',
          body: JSON.stringify({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
            Operations: [
              {
                method: 'POST',
                path: '/Users',
                bulkId: 'missing-user-schema',
                data: { userName: 'missing-user-schema' },
              },
            ],
          }),
        }),
        mockEnv as Env
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        Operations: [{ status: '400', response: { scimType: 'invalidValue' } }],
      });
    });

    it('returns a per-operation 400 error for an unsupported patch operation', async () => {
      const res = await app.fetch(
        createRequest('/scim/v2/Bulk', {
          method: 'POST',
          body: JSON.stringify({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
            Operations: [
              {
                method: 'PATCH',
                path: '/Users/user-001',
                data: {
                  schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
                  Operations: [{ op: 'move', path: 'active', value: true }],
                },
              },
            ],
          }),
        }),
        mockEnv as Env
      );

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        Operations: [{ status: '400', response: { scimType: 'invalidSyntax' } }],
      });
    });

    it('returns a per-operation 202 result for pending bulk account publication', async () => {
      accountCreationState.deliveryStatus = 202;
      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
          Operations: [
            {
              method: 'POST',
              path: '/Users',
              bulkId: 'pending-user-1',
              data: {
                schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
                userName: 'pending-bulk-user',
                emails: [{ value: 'pending.bulk@example.com', primary: true }],
              },
            },
          ],
        }),
      });

      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.Operations[0]).toMatchObject({
        bulkId: 'pending-user-1',
        status: '202',
        response: { status: 'directory_pending' },
      });
      expect(body.Operations[0].location).toContain('/scim/v2/Operations/');
    });

    it('rejects a bulk POST without the required bulkId before allocation', async () => {
      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
          Operations: [
            {
              method: 'POST',
              path: '/Users',
              data: {
                schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
                userName: 'missing-bulk-id',
                emails: [{ value: 'missing.bulk.id@example.com', primary: true }],
              },
            },
          ],
        }),
      });

      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.Operations[0]).toMatchObject({
        status: '400',
        response: { detail: 'POST operations require a valid bulkId' },
      });
      expect(accountCreationState.calls).toHaveLength(0);
    });

    it('should reject bulk user POST password provisioning', async () => {
      const bulkRequest = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          {
            method: 'POST',
            path: '/Users',
            bulkId: 'password-user',
            data: {
              schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
              userName: 'bulk-password-user',
              emails: [{ value: 'bulk.password@example.com', primary: true }],
              password: 'not-stored',
            },
          },
        ],
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.Operations[0].status).toBe('400');
      expect(body.Operations[0].response.scimType).toBe('invalidValue');
      expect(body.Operations[0].response.detail).toContain(
        'SCIM password provisioning is not supported'
      );
      expect([...mockUsers.values()]).not.toContainEqual(
        expect.objectContaining({ email: 'bulk.password@example.com' })
      );
    });

    it('should enforce required custom claim fields for bulk user POST operations', async () => {
      mockCustomClaimSchemas = [createCustomClaimSchemaRow()];

      const bulkRequest = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          {
            method: 'POST',
            path: '/Users',
            bulkId: 'user-required',
            data: {
              schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
              userName: 'bulk-missing-department',
              emails: [{ value: 'bulk.missing.department@example.com', primary: true }],
              active: true,
            },
          },
        ],
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.Operations[0].status).toBe('400');
      expect(body.Operations[0].response.detail).toContain('Department is required');
      expect(body.Operations[0].response.scimType).toBe('invalidValue');
      expect(body.Operations[0].response.missing_required_fields).toEqual([
        {
          field_key: 'department',
          label: 'Department',
          field_type: 'string',
        },
      ]);
    });

    it('should persist enterprise extension custom attributes for bulk user POST operations', async () => {
      mockCustomClaimSchemas = [createCustomClaimSchemaRow({ is_required: 0 })];

      const bulkRequest = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          {
            method: 'POST',
            path: '/Users',
            bulkId: 'user-enterprise',
            data: {
              schemas: [
                'urn:ietf:params:scim:schemas:core:2.0:User',
                'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
              ],
              userName: 'bulk-enterprise-user',
              emails: [{ value: 'bulk.enterprise@example.com', primary: true }],
              active: true,
              'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
                department: 'Support',
              },
            },
          },
        ],
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.Operations[0].status).toBe('201');
      expect(body.Operations[0].response.schemas).toContain(
        'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'
      );
      expect(
        body.Operations[0].response['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User']
          ?.department
      ).toBe('Support');
    });

    it('should reject bulk user PUT when a required custom claim would be removed', async () => {
      mockCustomClaimSchemas = [createCustomClaimSchemaRow()];
      mockUsers.get('user-001').custom_attributes_json = JSON.stringify({
        department: 'Engineering',
      });

      const bulkRequest = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          {
            method: 'PUT',
            path: '/Users/user-001',
            data: {
              schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
              userName: 'johndoe',
              emails: [{ value: 'john.doe@example.com', primary: true }],
              active: true,
            },
          },
        ],
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.Operations[0].status).toBe('400');
      expect(body.Operations[0].response.detail).toContain('Department is required');
      expect(body.Operations[0].response.scimType).toBe('invalidValue');
      expect(body.Operations[0].response.missing_required_fields).toEqual([
        {
          field_key: 'department',
          label: 'Department',
          field_type: 'string',
        },
      ]);
    });

    it('should preserve existing required custom claim values for bulk user PATCH operations', async () => {
      mockCustomClaimSchemas = [createCustomClaimSchemaRow()];
      mockUsers.get('user-001').custom_attributes_json = JSON.stringify({
        department: 'Engineering',
      });

      const bulkRequest = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          {
            method: 'PATCH',
            path: '/Users/user-001',
            data: {
              schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
              Operations: [{ op: 'replace', path: 'active', value: false }],
            },
          },
        ],
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.Operations[0].status).toBe('200');
      expect(
        body.Operations[0].response['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User']
          ?.department
      ).toBe('Engineering');
    });

    it('should reject bulk request with too many operations', async () => {
      // Generate more than 100 operations (default max)
      const operations = Array.from({ length: 101 }, (_, i) => ({
        method: 'POST',
        path: '/Users',
        bulkId: `user${i}`,
        data: {
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: `user${i}@example.com`,
          emails: [{ value: `user${i}@example.com`, primary: true }],
        },
      }));

      const bulkRequest = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: operations,
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(413);
      const body = (await res.json()) as any;
      expect(body.scimType).toBe('tooMany');
    });

    it('should require BulkRequest schema', async () => {
      const bulkRequest = {
        schemas: ['wrong:schema'],
        Operations: [],
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(400);
      const body = (await res.json()) as any;
      expect(body.scimType).toBe('invalidSyntax');
    });

    it('should handle DELETE operations', async () => {
      const bulkRequest = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          {
            method: 'DELETE',
            path: '/Users/user-001',
          },
        ],
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.Operations.length).toBe(1);
      expect(body.Operations[0].status).toBe('204');
    });

    it('should return 404 for non-existent resources', async () => {
      const bulkRequest = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          {
            method: 'DELETE',
            path: '/Users/non-existent-user',
          },
        ],
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.Operations[0].status).toBe('404');
    });

    it('should include Content-Type in response', async () => {
      const bulkRequest = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [],
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.headers.get('Content-Type')).toContain('application/scim+json');
    });

    it('should handle Group operations', async () => {
      const bulkRequest = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          {
            method: 'POST',
            path: '/Groups',
            bulkId: 'group1',
            data: {
              schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
              displayName: 'New Test Group',
            },
          },
        ],
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.Operations[0].status).toBe('201');
      expect(body.Operations[0].bulkId).toBe('group1');
    });

    it('should reject invalid path', async () => {
      const bulkRequest = {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:BulkRequest'],
        Operations: [
          {
            method: 'POST',
            path: '/InvalidResource',
            data: {},
          },
        ],
      };

      const req = createRequest('/scim/v2/Bulk', {
        method: 'POST',
        body: JSON.stringify(bulkRequest),
      });
      const res = await app.fetch(req, mockEnv as Env);

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.Operations[0].status).toBe('400');
    });
  });
});
