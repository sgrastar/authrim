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

import { describe, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '@authrim/ar-lib-core/types/env';
import scimApp from '../scim';

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
  bindingUnavailable: false,
  calls: [] as Array<Record<string, unknown>>,
  reservedSubjects: new Set<string>(),
}));

const accountOperationState = vi.hoisted(() => ({
  operation: null as Record<string, unknown> | null,
  error: null as Error | null,
}));

const accountRoutingState = vi.hoisted(() => ({
  error: null as Error | null,
  calls: [] as string[],
}));

const crossShardListState = vi.hoisted(() => ({
  calls: 0,
}));

const identifierReplacementState = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  error: null as Error | null,
}));

const customClaimRoutingState = vi.hoisted(() => ({
  rejectAccountLookup: false,
}));

const scimSettingsState = vi.hoisted(() => ({
  enabled: true,
  usersEnabled: true,
  groupsEnabled: true,
  bulkEnabled: true,
  mappingSetId: 'test-scim-mapping' as string | null,
  bulkMaxOperations: 100,
  bulkMaxPayloadSize: 1_048_576,
}));

const tenantState = vi.hoisted(() => ({
  tenantId: 'default',
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

    async list(input: {
      tenantId: string;
      limit?: number;
      includeInactive?: boolean;
      cursor?: string;
    }) {
      crossShardListState.calls += 1;
      const limit = input.limit ?? 100;
      const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
      const users = [...canonicalRuntimeState.users.values()]
        .filter(
          (user) =>
            (user.tenant_id ?? 'default') === input.tenantId &&
            user.lifecycle_state !== 'deleted' &&
            (input.includeInactive || user.active !== 0)
        )
        .sort(
          (left, right) =>
            Number(right.created_at) - Number(left.created_at) ||
            String(left.id).localeCompare(right.id)
        );
      const items = users.slice(offset, offset + limit).map((user) => ({
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
      const nextOffset = offset + items.length;
      return { items, nextCursor: nextOffset < users.length ? String(nextOffset) : null };
    }

    async count(input: { tenantId: string; includeInactive?: boolean }) {
      return [...canonicalRuntimeState.users.values()].filter(
        (user) =>
          (user.tenant_id ?? 'default') === input.tenantId &&
          user.lifecycle_state !== 'deleted' &&
          (input.includeInactive || user.active !== 0)
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
      if (
        !user ||
        (user.tenant_id ?? 'default') !== input.tenantId ||
        (input.purpose === 'active_search' && user.active === 0)
      )
        return [];
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

vi.mock('../scim-identifier-replacement', () => ({
  syncScimIdentifierReplacements: vi.fn(async (input: Record<string, unknown>) => {
    identifierReplacementState.calls.push(input);
    if (identifierReplacementState.error) throw identifierReplacementState.error;
  }),
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
      if (accountCreationState.capacityUnavailable) {
        throw new Error('control_account_allocation_capacity_unavailable');
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
        ([...canonicalRuntimeState.users.values()].some(
          (user) =>
            user.lifecycle_state !== 'deleted' &&
            user.preferred_username?.trim().toLowerCase() === input.externalSubject.subject
        ) ||
          accountCreationState.reservedSubjects.has(
            `${input.externalSubject.issuer}\0${input.externalSubject.subject}`
          ))
      ) {
        throw new Error('directory_identifier_reservation_conflict');
      }
      if (input.externalSubject) {
        accountCreationState.reservedSubjects.add(
          `${input.externalSubject.issuer}\0${input.externalSubject.subject}`
        );
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
  class MockScimIdentityMappingError extends Error {
    constructor(
      message: string,
      readonly code: string
    ) {
      super(message);
    }
  }
  return {
    applyScimInboundIdentityMapping: vi.fn(async ({ user }: { user: any }) => {
      const primaryEmail = user.emails?.find((item: any) => item.primary) ?? user.emails?.[0];
      if (!primaryEmail?.value) {
        throw new MockScimIdentityMappingError(
          'SCIM Mapping Set must produce authrim.profile.email',
          'mapping_required_output_missing'
        );
      }
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
    ScimIdentityMappingError: MockScimIdentityMappingError,
  };
});

vi.mock('../scim-settings', () => ({
  getScimInboundSettings: vi.fn(async () => ({ ...scimSettingsState })),
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
    getTenantIdFromContext: vi.fn(() => tenantState.tenantId),
    createAuthContextFromHono: vi.fn((c: any, tenantId = 'default') => ({
      tenantId,
      coreAdapter: actual.ensureDatabaseAdapter(c.env.DB, 'test-scim-metadata'),
      repositories: {},
      cache: new Map(),
      honoContext: c,
    })),
    resolveAccountDataContext: vi.fn(
      async (env: Partial<Env>, input: { tenantId?: string; accountId: string }) => {
        const userId = input.accountId.replace(/^account:/, '');
        accountRoutingState.calls.push(userId);
        if (accountRoutingState.error) throw accountRoutingState.error;
        const user = canonicalRuntimeState.users.get(userId);
        if (!user || (user.tenant_id ?? 'default') !== (input.tenantId ?? tenantState.tenantId)) {
          throw new Error('account_data_route_not_found');
        }
        return {
          tenantId: input.tenantId ?? tenantState.tenantId,
          accountId: `account:${userId}`,
          legacyUserId: userId,
          coreDb: env.DB,
          piiDb: env.DB_PII,
        };
      }
    ),
    resolveAccountDataContextFromHono: vi.fn(async (c: any, accountId: string) => {
      const userId = accountId.replace(/^account:/, '');
      accountRoutingState.calls.push(userId);
      if (accountRoutingState.error) throw accountRoutingState.error;
      const user = canonicalRuntimeState.users.get(userId);
      if (!user || (user.tenant_id ?? 'default') !== tenantState.tenantId) {
        throw new Error('account_data_route_not_found');
      }
      return {
        tenantId: tenantState.tenantId,
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

export interface ScimTestHarness {
  readonly app: Hono;
  readonly env: Partial<Env>;
  readonly users: Map<string, any>;
  readonly groups: Map<string, any>;
  readonly userRoles: Map<string, any[]>;
  readonly customClaimSchemas: Array<Record<string, unknown>>;
  readonly sessionRevocationStates: Map<
    string,
    { lifecycle: string; lifecycleVersionMs: number | null }
  >;
  readonly accountCreation: typeof accountCreationState;
  readonly accountOperation: typeof accountOperationState;
  readonly accountRouting: typeof accountRoutingState;
  readonly crossShardList: typeof crossShardListState;
  readonly identifierReplacement: typeof identifierReplacementState;
  readonly customClaimRouting: typeof customClaimRoutingState;
  readonly settings: typeof scimSettingsState;
  readonly tenant: typeof tenantState;
  readonly accountRemoval: typeof accountRemovalState;
  createRequest(path: string, options?: RequestInit): Request;
  createCustomClaimSchemaRow(overrides?: Record<string, unknown>): Record<string, unknown>;
  setCustomClaimSchemas(rows: Array<Record<string, unknown>>): void;
}

export function describeScimTestHarness(
  name: string,
  register: (harness: ScimTestHarness) => void
): void {
  describe(name, () => {
    let app: Hono;
    let mockEnv: Partial<Env>;
    let mockUsers: Map<string, any>;
    let mockGroups: Map<string, any>;
    let mockUserRoles: Map<string, any[]>;
    let mockCustomClaimSchemas: Array<Record<string, unknown>>;
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
      accountCreationState.bindingUnavailable = false;
      accountCreationState.calls = [];
      accountCreationState.reservedSubjects.clear();
      accountOperationState.operation = null;
      accountOperationState.error = null;
      accountRoutingState.error = null;
      accountRoutingState.calls = [];
      crossShardListState.calls = 0;
      identifierReplacementState.calls = [];
      identifierReplacementState.error = null;
      customClaimRoutingState.rejectAccountLookup = false;
      Object.assign(scimSettingsState, {
        enabled: true,
        usersEnabled: true,
        groupsEnabled: true,
        bulkEnabled: true,
        mappingSetId: 'test-scim-mapping',
        bulkMaxOperations: 100,
        bulkMaxPayloadSize: 1_048_576,
      });
      tenantState.tenantId = 'default';
      mockUsers = new Map();
      canonicalRuntimeState.users = mockUsers;
      mockGroups = new Map();
      mockUserRoles = new Map();
      mockCustomClaimSchemas = [];
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

    register({
      get app() {
        return app;
      },
      get env() {
        return mockEnv;
      },
      get users() {
        return mockUsers;
      },
      get groups() {
        return mockGroups;
      },
      get userRoles() {
        return mockUserRoles;
      },
      get customClaimSchemas() {
        return mockCustomClaimSchemas;
      },
      get sessionRevocationStates() {
        return sessionRevocationStates;
      },
      accountCreation: accountCreationState,
      accountOperation: accountOperationState,
      accountRouting: accountRoutingState,
      crossShardList: crossShardListState,
      identifierReplacement: identifierReplacementState,
      customClaimRouting: customClaimRoutingState,
      settings: scimSettingsState,
      tenant: tenantState,
      accountRemoval: accountRemovalState,
      createRequest,
      createCustomClaimSchemaRow,
      setCustomClaimSchemas(rows) {
        mockCustomClaimSchemas = rows;
      },
    });
  });
}
