import type { D1Database } from '@cloudflare/workers-types';
import type { Context as HonoContext } from 'hono';
import type { DatabaseSource } from '../db';
import type { Env } from '../types/env';
import { isCanonicalAccountIdForUser, isValidPersistedUserId } from '../utils/id';
import type { UserCacheScope, UserPiiCacheMode } from '../utils/kv';
import {
  createLookupBlindIndexes,
  loadVerifiedLookupBucketAssignmentProvider,
  loadVerifiedLookupHmacKeyState,
  LookupRouteResolver,
  resolveLookupHmacKeys,
  type ResolvedLookupHmacKeys,
  type ResolvedLookupMembership,
  type ResolvedLookupTarget,
  type LookupIdentifierKind,
} from './lookup-directory';
import {
  getCachedAuthCorePersistenceContextFromEnv,
  resolveAuthCorePersistenceSourceFromEnv,
} from './auth-core-persistence-context';

const RUNTIME_STATE_CACHE_TTL_MS = 30_000;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

interface CachedRuntimeState<T> {
  value: T;
  loadedAt: number;
}

interface AccountDestinationRow {
  id: string;
  legacy_user_id: string;
  lifecycle_state: string;
  directory_publication_state: string;
  account_route_generation: number | string;
}

interface ShardMetadataRow {
  binding_ref: string;
  data_role: string;
  residency_partition: string;
}

interface SessionRevocationEpochRow {
  revoked_after_ms: number | string;
}

export interface TenantMetadataContext {
  tenantId: string;
  storageProfileId: string;
  coreDb: DatabaseSource;
}

export interface AccountDataContext {
  tenantId: string;
  accountId: string;
  legacyUserId: string;
  storageProfileId: string;
  membership: ResolvedLookupMembership;
  coreDb: DatabaseSource;
  piiDb: DatabaseSource;
  coreBindingRef: string;
  piiBindingRef: string;
  coreResidencyPartition: string;
  piiResidencyPartition: string;
  accountRouteGeneration: number;
  userCacheScope: UserCacheScope;
  piiCacheMode: UserPiiCacheMode;
}

export interface AccountCoreDataContext {
  tenantId: string;
  accountId: string;
  legacyUserId: string;
  storageProfileId: string;
  membership: ResolvedLookupMembership;
  coreDb: DatabaseSource;
  coreBindingRef: string;
  coreResidencyPartition: string;
  accountRouteGeneration: number;
}

export interface SessionAccountCoreDataContext extends AccountCoreDataContext {
  revokedAfterMs: number | null;
}

interface AccountRouteResolutionBase {
  resolver: LookupRouteResolver;
  membership: ResolvedLookupMembership;
  accountId: string;
  storageProfileId: string;
  observedBindingRouteGenerations: Readonly<Record<string, number>>;
  coreResidency: string;
  piiResidency: string;
}

const hmacKeyCache = new WeakMap<object, CachedRuntimeState<ResolvedLookupHmacKeys>>();

function requiredEnvironment(env: Env): {
  environmentId: string;
  store: KVNamespace;
  publicJwks: string;
} {
  if (
    !env.AUTHRIM_ENVIRONMENT_NAME ||
    !SAFE_ID.test(env.AUTHRIM_ENVIRONMENT_NAME) ||
    !env.TENANT_RUNTIME_REGISTRY ||
    !env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS
  ) {
    throw new Error('account_data_runtime_registry_unavailable');
  }
  return {
    environmentId: env.AUTHRIM_ENVIRONMENT_NAME,
    store: env.TENANT_RUNTIME_REGISTRY,
    publicJwks: env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS,
  };
}

function normalizeAccountId(value: string): string {
  const normalized = value.trim();
  const accountId = normalized.startsWith('account:') ? normalized : `account:${normalized}`;
  if (!SAFE_ID.test(accountId)) throw new Error('account_data_account_id_invalid');
  return accountId;
}

async function loadHmacKeys(env: Env, now: number): Promise<ResolvedLookupHmacKeys> {
  const cached = hmacKeyCache.get(env as object);
  if (cached && now - cached.loadedAt < RUNTIME_STATE_CACHE_TTL_MS) return cached.value;
  const runtime = requiredEnvironment(env);
  const state = await loadVerifiedLookupHmacKeyState({
    store: runtime.store,
    environmentId: runtime.environmentId,
    publicJwks: runtime.publicJwks,
    now: Math.floor(now / 1000),
  });
  const value = await resolveLookupHmacKeys({
    state,
    slotA: env.LOOKUP_HMAC_KEY_SLOT_A,
    slotB: env.LOOKUP_HMAC_KEY_SLOT_B,
  });
  hmacKeyCache.set(env as object, { value, loadedAt: now });
  return value;
}

async function firstPrimary<T>(
  source: D1Database,
  sql: string,
  params: unknown[]
): Promise<T | null> {
  return source
    .withSession('first-primary')
    .prepare(sql)
    .bind(...params)
    .first<T>();
}

async function verifyShardMetadata(
  target: ResolvedLookupTarget,
  expectedRole: 'tenant_core/users' | 'tenant_pii'
): Promise<boolean> {
  const row = await firstPrimary<ShardMetadataRow>(
    target.source,
    `SELECT binding_ref, data_role, residency_partition
       FROM authrim_control_plane_shard_metadata WHERE singleton_id = 1`,
    []
  );
  return (
    row?.binding_ref === target.bindingRef &&
    row.data_role === expectedRole &&
    row.residency_partition === target.residencyPartition
  );
}

async function resolveAccountRouteBaseByIdentifier(
  env: Env,
  input: {
    tenantId: string;
    indexKind: LookupIdentifierKind;
    identifier: string | { issuer: string; subject: string };
    expectedAccountId?: string;
    nowMs?: number;
  }
): Promise<AccountRouteResolutionBase> {
  if (!SAFE_ID.test(input.tenantId)) throw new Error('account_data_tenant_id_invalid');
  const now = input.nowMs ?? Date.now();
  const runtime = requiredEnvironment(env);
  const [keys, assignments, persistence] = await Promise.all([
    loadHmacKeys(env, now),
    loadVerifiedLookupBucketAssignmentProvider({
      store: runtime.store,
      environmentId: runtime.environmentId,
      publicJwks: runtime.publicJwks,
      now: Math.floor(now / 1000),
    }),
    getCachedAuthCorePersistenceContextFromEnv(env),
  ]);
  const indexes = await createLookupBlindIndexes(input.indexKind, input.identifier, keys.readKeys);
  const resolver = new LookupRouteResolver(env as unknown as Record<string, unknown>, assignments);
  const memberships = (await resolver.resolveMemberships({ indexes })).filter((membership) => {
    if (membership.tenantId !== input.tenantId) return false;
    return (
      input.expectedAccountId === undefined || membership.accountId === input.expectedAccountId
    );
  });
  if (memberships.length !== 1) {
    throw new Error(
      memberships.length === 0 ? 'account_data_route_not_found' : 'account_data_route_ambiguous'
    );
  }
  const membership = memberships[0];
  const accountId = membership.accountId;
  const observedBindingRouteGenerations = Object.fromEntries(
    membership.routeProjection.targets.map((target) => [
      target.bindingRef,
      target.requiredBindingRouteGeneration,
    ])
  );
  const coreResidency = membership.routeProjection.targets.find(
    (target) => target.dataRole === 'tenant_core/users'
  )?.residencyPartition;
  const piiResidency = membership.routeProjection.targets.find(
    (target) => target.dataRole === 'tenant_pii'
  )?.residencyPartition;
  if (!coreResidency || !piiResidency) throw new Error('account_data_route_incomplete');

  return {
    resolver,
    membership,
    accountId,
    storageProfileId: persistence.storageProfileId,
    observedBindingRouteGenerations,
    coreResidency,
    piiResidency,
  };
}

async function resolveCoreAccountDestination(
  base: AccountRouteResolutionBase,
  tenantId: string,
  revocationUserId?: string
): Promise<{
  target: ResolvedLookupTarget;
  account: AccountDestinationRow;
  revokedAfterMs: number | null;
}> {
  const account: { value: AccountDestinationRow | null } = { value: null };
  let revokedAfterMs: number | null = null;
  const target = await base.resolver.resolveTargetAndRevalidate({
    membership: base.membership,
    dataRole: 'tenant_core/users',
    residencyPartition: base.coreResidency,
    observedBindingRouteGenerations: base.observedBindingRouteGenerations,
    verifyAtDestination: async (candidate) => {
      const session = candidate.source.withSession('first-primary');
      const statements = [
        session.prepare(
          `SELECT binding_ref, data_role, residency_partition
             FROM authrim_control_plane_shard_metadata WHERE singleton_id = 1`
        ),
        session
          .prepare(
            `SELECT id, legacy_user_id, lifecycle_state, directory_publication_state,
                    account_route_generation
               FROM identity_accounts WHERE tenant_id = ? AND id = ? LIMIT 1`
          )
          .bind(tenantId, base.accountId),
      ];
      if (revocationUserId) {
        statements.push(
          session
            .prepare(
              `SELECT revoked_after_ms
                 FROM session_revocation_epochs
                WHERE tenant_id = ? AND user_id = ? LIMIT 1`
            )
            .bind(tenantId, revocationUserId)
        );
      }
      const results = await session.batch(statements);
      if (
        results.length !== statements.length ||
        results.some((result) => result.success !== true)
      ) {
        return false;
      }
      const metadata = results[0]?.results[0] as ShardMetadataRow | undefined;
      account.value = (results[1]?.results[0] as AccountDestinationRow | undefined) ?? null;
      const epoch = revocationUserId
        ? ((results[2]?.results[0] as SessionRevocationEpochRow | undefined) ?? null)
        : null;
      if (
        metadata?.binding_ref !== candidate.bindingRef ||
        metadata.data_role !== 'tenant_core/users' ||
        metadata.residency_partition !== candidate.residencyPartition ||
        account.value?.id !== base.accountId ||
        account.value.lifecycle_state !== 'active' ||
        account.value.directory_publication_state !== 'active' ||
        Number(account.value.account_route_generation) !== base.membership.accountRouteGeneration ||
        (revocationUserId !== undefined && account.value.legacy_user_id !== revocationUserId)
      ) {
        return false;
      }
      if (epoch) {
        const normalizedEpoch = Number(epoch.revoked_after_ms);
        if (!Number.isSafeInteger(normalizedEpoch) || normalizedEpoch < 0) return false;
        revokedAfterMs = normalizedEpoch;
      }
      return true;
    },
  });
  if (!account.value || !isValidPersistedUserId(account.value.legacy_user_id)) {
    throw new Error('account_data_destination_account_invalid');
  }
  return { target, account: account.value, revokedAfterMs };
}

function piiCacheMode(env: Env): UserPiiCacheMode {
  return env.PII_CACHE_MODE === 'merged' ||
    env.PII_CACHE_MODE === 'encrypted_short_ttl' ||
    env.PII_CACHE_MODE === 'no_cross_request_pii'
    ? env.PII_CACHE_MODE
    : 'encrypted_short_ttl';
}

export async function resolveTenantMetadataContext(
  env: Env,
  tenantId: string
): Promise<TenantMetadataContext> {
  if (!SAFE_ID.test(tenantId)) throw new Error('tenant_metadata_tenant_id_invalid');
  const persistence = await getCachedAuthCorePersistenceContextFromEnv(env);
  return {
    tenantId,
    storageProfileId: persistence.storageProfileId,
    coreDb: await resolveAuthCorePersistenceSourceFromEnv(env, {
      tenantId,
      runtimeSnapshotMode:
        persistence.storageProfileId === 'builtin:storage:tenant-d1' ? 'required' : 'optional',
    }),
  };
}

export async function resolveAccountDataContextByIdentifier(
  env: Env,
  input: {
    tenantId: string;
    indexKind: LookupIdentifierKind;
    identifier: string | { issuer: string; subject: string };
    expectedAccountId?: string;
    nowMs?: number;
  }
): Promise<AccountDataContext> {
  const base = await resolveAccountRouteBaseByIdentifier(env, input);
  const [coreResolution, pii] = await Promise.all([
    resolveCoreAccountDestination(base, input.tenantId),
    base.resolver.resolveTargetAndRevalidate({
      membership: base.membership,
      dataRole: 'tenant_pii',
      residencyPartition: base.piiResidency,
      observedBindingRouteGenerations: base.observedBindingRouteGenerations,
      verifyAtDestination: (target) => verifyShardMetadata(target, 'tenant_pii'),
    }),
  ]);
  const { target: core, account: accountRow } = coreResolution;
  const { membership, accountId } = base;
  const userCacheScope: UserCacheScope = {
    storageProfileId: base.storageProfileId,
    sourceGeneration: `account:${membership.accountRouteGeneration}:core:${core.requiredBindingRouteGeneration}:pii:${pii.requiredBindingRouteGeneration}`,
    schemaVersion: `route:${membership.routeProjection.schemaVersion}`,
  };
  return {
    tenantId: input.tenantId,
    accountId,
    legacyUserId: accountRow.legacy_user_id,
    storageProfileId: base.storageProfileId,
    membership,
    coreDb: core.source,
    piiDb: pii.source,
    coreBindingRef: core.bindingRef,
    piiBindingRef: pii.bindingRef,
    coreResidencyPartition: core.residencyPartition,
    piiResidencyPartition: pii.residencyPartition,
    accountRouteGeneration: membership.accountRouteGeneration,
    userCacheScope,
    piiCacheMode: piiCacheMode(env),
  };
}

export async function resolveAccountCoreDataContext(
  env: Env,
  input: { tenantId: string; accountId: string; nowMs?: number }
): Promise<AccountCoreDataContext> {
  const accountId = normalizeAccountId(input.accountId);
  const base = await resolveAccountRouteBaseByIdentifier(env, {
    tenantId: input.tenantId,
    indexKind: 'account_id',
    identifier: accountId,
    expectedAccountId: accountId,
    nowMs: input.nowMs,
  });
  const [{ target, account }] = await Promise.all([
    resolveCoreAccountDestination(base, input.tenantId),
    base.resolver.resolveTargetAndRevalidate({
      membership: base.membership,
      dataRole: 'tenant_pii',
      residencyPartition: base.piiResidency,
      observedBindingRouteGenerations: base.observedBindingRouteGenerations,
      verifyAtDestination: (target) => verifyShardMetadata(target, 'tenant_pii'),
    }),
  ]);
  return {
    tenantId: input.tenantId,
    accountId,
    legacyUserId: account.legacy_user_id,
    storageProfileId: base.storageProfileId,
    membership: base.membership,
    coreDb: target.source,
    coreBindingRef: target.bindingRef,
    coreResidencyPartition: target.residencyPartition,
    accountRouteGeneration: base.membership.accountRouteGeneration,
  };
}

export async function resolveSessionAccountCoreDataContext(
  env: Env,
  input: { tenantId: string; accountId: string; userId: string; nowMs?: number }
): Promise<SessionAccountCoreDataContext> {
  const accountId = normalizeAccountId(input.accountId);
  const userId = input.userId.trim();
  if (!isCanonicalAccountIdForUser(accountId, userId)) {
    throw new Error('account_data_session_route_mismatch');
  }
  const base = await resolveAccountRouteBaseByIdentifier(env, {
    tenantId: input.tenantId,
    indexKind: 'account_id',
    identifier: accountId,
    expectedAccountId: accountId,
    nowMs: input.nowMs,
  });
  const [{ target, account, revokedAfterMs }] = await Promise.all([
    resolveCoreAccountDestination(base, input.tenantId, userId),
    base.resolver.resolveTargetAndRevalidate({
      membership: base.membership,
      dataRole: 'tenant_pii',
      residencyPartition: base.piiResidency,
      observedBindingRouteGenerations: base.observedBindingRouteGenerations,
      verifyAtDestination: (target) => verifyShardMetadata(target, 'tenant_pii'),
    }),
  ]);
  return {
    tenantId: input.tenantId,
    accountId,
    legacyUserId: account.legacy_user_id,
    storageProfileId: base.storageProfileId,
    membership: base.membership,
    coreDb: target.source,
    coreBindingRef: target.bindingRef,
    coreResidencyPartition: target.residencyPartition,
    accountRouteGeneration: base.membership.accountRouteGeneration,
    revokedAfterMs,
  };
}

export async function resolveAccountDataContext(
  env: Env,
  input: { tenantId: string; accountId: string; nowMs?: number }
): Promise<AccountDataContext> {
  const accountId = normalizeAccountId(input.accountId);
  return resolveAccountDataContextByIdentifier(env, {
    tenantId: input.tenantId,
    indexKind: 'account_id',
    identifier: accountId,
    expectedAccountId: accountId,
    nowMs: input.nowMs,
  });
}

export async function resolveAccountDataContextByIdentifierFromHono(
  c: HonoContext<{ Bindings: Env }>,
  input: {
    indexKind: 'email_exact' | 'external_subject';
    identifier: string | { issuer: string; subject: string };
  }
): Promise<AccountDataContext> {
  const tenantId =
    ((c as unknown as { get(key: string): unknown }).get('tenantId') as string) ?? '';
  const existing = getAccountDataContextFromHono(c);
  if (existing) {
    if (existing.tenantId !== tenantId) throw new Error('account_data_context_conflict');
    return existing;
  }
  const resolved = await resolveAccountDataContextByIdentifier(c.env, {
    tenantId,
    indexKind: input.indexKind,
    identifier: input.identifier,
  });
  (c as unknown as { set(key: string, value: unknown): void }).set('accountDataContext', resolved);
  return resolved;
}

export function getTenantMetadataContextFromHono(
  c: HonoContext<{ Bindings: Env }>
): TenantMetadataContext | undefined {
  return (c as unknown as { get(key: string): unknown }).get('tenantMetadataContext') as
    | TenantMetadataContext
    | undefined;
}

export function getAccountDataContextFromHono(
  c: HonoContext<{ Bindings: Env }>
): AccountDataContext | undefined {
  return (c as unknown as { get(key: string): unknown }).get('accountDataContext') as
    | AccountDataContext
    | undefined;
}

export async function resolveAccountDataContextFromHono(
  c: HonoContext<{ Bindings: Env }>,
  accountId: string
): Promise<AccountDataContext> {
  const tenantId =
    ((c as unknown as { get(key: string): unknown }).get('tenantId') as string) ?? '';
  const normalizedAccountId = normalizeAccountId(accountId);
  const existing = getAccountDataContextFromHono(c);
  if (existing) {
    if (existing.tenantId !== tenantId || existing.accountId !== normalizedAccountId) {
      throw new Error('account_data_context_conflict');
    }
    return existing;
  }
  const resolved = await resolveAccountDataContext(c.env, {
    tenantId,
    accountId: normalizedAccountId,
  });
  (c as unknown as { set(key: string, value: unknown): void }).set('accountDataContext', resolved);
  return resolved;
}
