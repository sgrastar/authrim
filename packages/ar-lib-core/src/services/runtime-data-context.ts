import type { D1Database } from '@cloudflare/workers-types';
import type { Context as HonoContext } from 'hono';
import type { DatabaseSource } from '../db';
import type { CanonicalOtpLoginUser } from '../repositories/identity/canonical-runtime-user-store';
import type { Env } from '../types/env';
import { isValidPersistedUserId } from '../utils/id';
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
  resolveTenantDatabaseSourceFromRegistry,
  type ResolvedTenantDatabaseSource,
} from './tenant-database-resolver';

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

interface OtpAccountDestinationRow extends AccountDestinationRow {
  account_type: string;
  subject_lifecycle_state: string;
  display_name: string | null;
  email_verified: number | string;
  created_at: number | string;
}

interface ShardMetadataRow {
  binding_ref: string;
  data_role: string;
  residency_partition: string;
}

export interface TenantMetadataContext {
  tenantId: string;
  coreDb: DatabaseSource;
  route: ResolvedTenantDatabaseSource;
}

export interface AccountDataContext {
  tenantId: string;
  accountId: string;
  legacyUserId: string;
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
  membership: ResolvedLookupMembership;
  coreDb: DatabaseSource;
  coreBindingRef: string;
  coreResidencyPartition: string;
  accountRouteGeneration: number;
}

export interface OtpAccountCoreDataContext extends AccountCoreDataContext {
  user: CanonicalOtpLoginUser;
}

interface AccountRouteResolutionBase {
  resolver: LookupRouteResolver;
  membership: ResolvedLookupMembership;
  accountId: string;
  observedBindingRouteGenerations: Readonly<Record<string, number>>;
  coreResidency: string;
  piiResidency: string;
  coreRoute: ResolvedTenantDatabaseSource;
  piiRoute: ResolvedTenantDatabaseSource;
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

function timestampToIso(value: number | string): string | null {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return null;
  const absolute = Math.abs(timestamp);
  const milliseconds =
    absolute < 100_000_000_000
      ? timestamp * 1000
      : absolute < 100_000_000_000_000
        ? timestamp
        : absolute < 100_000_000_000_000_000
          ? timestamp / 1000
          : timestamp / 1_000_000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
  const [keys, assignments] = await Promise.all([
    loadHmacKeys(env, now),
    loadVerifiedLookupBucketAssignmentProvider({
      store: runtime.store,
      environmentId: runtime.environmentId,
      publicJwks: runtime.publicJwks,
      now: Math.floor(now / 1000),
    }),
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
  const coreTarget = membership.routeProjection.targets.find(
    (target) =>
      target.dataRole === 'tenant_core/users' && target.residencyPartition === coreResidency
  );
  const piiTarget = membership.routeProjection.targets.find(
    (target) => target.dataRole === 'tenant_pii' && target.residencyPartition === piiResidency
  );
  if (!coreTarget || !piiTarget) throw new Error('account_data_route_incomplete');
  const [coreRoute, piiRoute] = await Promise.all([
    resolveTenantDatabaseSourceFromRegistry(env, {
      tenantId: input.tenantId,
      role: 'tenant_core',
      dataRole: 'tenant_core/users',
      residencyPartition: coreTarget.residencyPartition,
      shardId: coreTarget.shardId,
      bindingRef: coreTarget.bindingRef,
      requiredBindingRouteGeneration: coreTarget.requiredBindingRouteGeneration,
    }),
    resolveTenantDatabaseSourceFromRegistry(env, {
      tenantId: input.tenantId,
      role: 'tenant_pii',
      dataRole: 'tenant_pii',
      residencyPartition: piiTarget.residencyPartition,
      shardId: piiTarget.shardId,
      bindingRef: piiTarget.bindingRef,
      requiredBindingRouteGeneration: piiTarget.requiredBindingRouteGeneration,
    }),
  ]);

  return {
    resolver,
    membership,
    accountId,
    observedBindingRouteGenerations,
    coreResidency,
    piiResidency,
    coreRoute,
    piiRoute,
  };
}

async function resolveCoreAccountDestination(
  base: AccountRouteResolutionBase,
  tenantId: string,
  options: { otpTrustedEmail?: string } = {}
): Promise<{
  target: ResolvedLookupTarget;
  account: AccountDestinationRow;
  otpUser: CanonicalOtpLoginUser | null;
}> {
  const account: { value: AccountDestinationRow | null } = { value: null };
  const otpUser: { value: CanonicalOtpLoginUser | null } = { value: null };
  const otpTrustedEmail = options.otpTrustedEmail?.trim().toLowerCase() || null;
  if (options.otpTrustedEmail !== undefined && !otpTrustedEmail) {
    throw new Error('account_data_otp_email_invalid');
  }
  const target = await base.resolver.resolveTargetAndRevalidate({
    membership: base.membership,
    dataRole: 'tenant_core/users',
    residencyPartition: base.coreResidency,
    observedBindingRouteGenerations: base.observedBindingRouteGenerations,
    verifyAtDestination: async (candidate) => {
      if (
        candidate.source !== base.coreRoute.source ||
        candidate.bindingRef !== base.coreRoute.bindingRef ||
        candidate.shardId !== base.coreRoute.shardId ||
        candidate.requiredBindingRouteGeneration !== base.coreRoute.bindingRouteGeneration
      ) {
        return false;
      }
      const session = candidate.source.withSession('first-primary');
      const statements = [
        session.prepare(
          `SELECT binding_ref, data_role, residency_partition
             FROM authrim_control_plane_shard_metadata WHERE singleton_id = 1`
        ),
        otpTrustedEmail
          ? session
              .prepare(
                `SELECT account.id,
                        account.legacy_user_id,
                        account.lifecycle_state,
                        account.directory_publication_state,
                        account.account_route_generation,
                        account.account_type,
                        account.created_at,
                        subject.lifecycle_state AS subject_lifecycle_state,
                        COALESCE(subject.display_label, account.display_label) AS display_name,
                        COALESCE(
                          (
                            SELECT CASE WHEN contact.verification_state = 'verified' THEN 1 ELSE 0 END
                              FROM contact_points contact
                             WHERE contact.tenant_id = account.tenant_id
                               AND contact.subject_id = subject.id
                               AND contact.contact_type = 'email'
                               AND contact.lifecycle_state = 'active'
                             LIMIT 1
                          ),
                          (
                            SELECT CASE WHEN contact.verification_state = 'verified' THEN 1 ELSE 0 END
                              FROM contact_points contact
                             WHERE contact.tenant_id = account.tenant_id
                               AND contact.account_id = account.id
                               AND contact.contact_type = 'email'
                               AND contact.lifecycle_state = 'active'
                             LIMIT 1
                          ),
                          0
                        ) AS email_verified
                   FROM identity_accounts account
                   JOIN identity_subjects subject
                     ON subject.id = account.primary_subject_id
                    AND subject.tenant_id = account.tenant_id
                  WHERE account.tenant_id = ? AND account.id = ?
                  LIMIT 1`
              )
              .bind(tenantId, base.accountId)
          : session
              .prepare(
                `SELECT id, legacy_user_id, lifecycle_state, directory_publication_state,
                        account_route_generation
                   FROM identity_accounts WHERE tenant_id = ? AND id = ? LIMIT 1`
              )
              .bind(tenantId, base.accountId),
      ];
      const results = await session.batch(statements);
      if (
        results.length !== statements.length ||
        results.some((result) => result.success !== true)
      ) {
        return false;
      }
      const metadata = results[0]?.results[0] as ShardMetadataRow | undefined;
      account.value = (results[1]?.results[0] as AccountDestinationRow | undefined) ?? null;
      if (
        metadata?.binding_ref !== candidate.bindingRef ||
        metadata.data_role !== 'tenant_core/users' ||
        metadata.residency_partition !== candidate.residencyPartition ||
        account.value?.id !== base.accountId ||
        account.value.lifecycle_state !== 'active' ||
        account.value.directory_publication_state !== 'active' ||
        Number(account.value.account_route_generation) !== base.membership.accountRouteGeneration
      ) {
        return false;
      }
      if (otpTrustedEmail) {
        const otpRow = account.value as OtpAccountDestinationRow;
        const createdAt = timestampToIso(otpRow.created_at);
        if (!otpRow.account_type || !otpRow.subject_lifecycle_state || !createdAt) return false;
        otpUser.value = {
          id: otpRow.legacy_user_id,
          email: otpTrustedEmail,
          name: otpRow.display_name,
          active: otpRow.subject_lifecycle_state === 'active' ? 1 : 0,
          email_verified: Number(otpRow.email_verified) === 1 ? 1 : 0,
          account_type: otpRow.account_type,
          created_at: createdAt,
        };
      }
      return true;
    },
  });
  if (!account.value || !isValidPersistedUserId(account.value.legacy_user_id)) {
    throw new Error('account_data_destination_account_invalid');
  }
  return { target, account: account.value, otpUser: otpUser.value };
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
  const route = await resolveTenantDatabaseSourceFromRegistry(env, {
    tenantId,
    role: 'tenant_core',
    dataRole: 'tenant_core/default',
    shardGroup: 'default',
    shardIndex: 0,
  });
  return {
    tenantId,
    coreDb: route.source,
    route,
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
      verifyAtDestination: (target) => {
        if (
          target.source !== base.piiRoute.source ||
          target.bindingRef !== base.piiRoute.bindingRef ||
          target.shardId !== base.piiRoute.shardId ||
          target.requiredBindingRouteGeneration !== base.piiRoute.bindingRouteGeneration
        ) {
          return Promise.resolve(false);
        }
        return verifyShardMetadata(target, 'tenant_pii');
      },
    }),
  ]);
  const { target: core, account: accountRow } = coreResolution;
  const { membership, accountId } = base;
  const userCacheScope: UserCacheScope = {
    routeGeneration: `account:${membership.accountRouteGeneration}`,
    bindingGeneration: `core:${core.requiredBindingRouteGeneration}:pii:${pii.requiredBindingRouteGeneration}`,
    schemaGeneration: `route:${membership.routeProjection.schemaVersion}`,
  };
  return {
    tenantId: input.tenantId,
    accountId,
    legacyUserId: accountRow.legacy_user_id,
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
  const { target, account } = await resolveCoreAccountDestination(base, input.tenantId);
  return {
    tenantId: input.tenantId,
    accountId,
    legacyUserId: account.legacy_user_id,
    membership: base.membership,
    coreDb: target.source,
    coreBindingRef: target.bindingRef,
    coreResidencyPartition: target.residencyPartition,
    accountRouteGeneration: base.membership.accountRouteGeneration,
  };
}

/**
 * Resolve an OTP identifier to its authoritative Core shard and return the complete minimal
 * login projection from the destination revalidation batch. The trusted email is already bound
 * to the account by the Lookup membership, so this path intentionally does not touch tenant PII.
 */
export async function resolveOtpAccountCoreDataContextByIdentifier(
  env: Env,
  input: {
    tenantId: string;
    indexKind: 'email_exact' | 'account_id';
    identifier: string;
    trustedEmail: string;
    expectedAccountId?: string;
    expectedLegacyUserId?: string;
    nowMs?: number;
  }
): Promise<OtpAccountCoreDataContext> {
  const identifier =
    input.indexKind === 'account_id' ? normalizeAccountId(input.identifier) : input.identifier;
  const expectedAccountId =
    input.expectedAccountId !== undefined
      ? normalizeAccountId(input.expectedAccountId)
      : input.indexKind === 'account_id'
        ? identifier
        : undefined;
  const trustedEmail = input.trustedEmail.trim().toLowerCase();
  if (input.indexKind === 'email_exact' && input.identifier.trim().toLowerCase() !== trustedEmail) {
    throw new Error('account_data_otp_email_route_mismatch');
  }
  const base = await resolveAccountRouteBaseByIdentifier(env, {
    tenantId: input.tenantId,
    indexKind: input.indexKind,
    identifier,
    expectedAccountId,
    nowMs: input.nowMs,
  });
  const { target, account, otpUser } = await resolveCoreAccountDestination(base, input.tenantId, {
    otpTrustedEmail: trustedEmail,
  });
  if (
    input.expectedLegacyUserId !== undefined &&
    account.legacy_user_id !== input.expectedLegacyUserId
  ) {
    throw new Error('account_data_otp_route_mismatch');
  }
  if (!otpUser) throw new Error('account_data_otp_projection_invalid');
  return {
    tenantId: input.tenantId,
    accountId: base.accountId,
    legacyUserId: account.legacy_user_id,
    membership: base.membership,
    coreDb: target.source,
    coreBindingRef: target.bindingRef,
    coreResidencyPartition: target.residencyPartition,
    accountRouteGeneration: base.membership.accountRouteGeneration,
    user: otpUser,
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

export async function resolveOtpAccountCoreDataContextByIdentifierFromHono(
  c: HonoContext<{ Bindings: Env }>,
  input: {
    indexKind: 'email_exact' | 'account_id';
    identifier: string;
    trustedEmail: string;
    expectedAccountId?: string;
    expectedLegacyUserId?: string;
  }
): Promise<OtpAccountCoreDataContext> {
  const tenantId =
    ((c as unknown as { get(key: string): unknown }).get('tenantId') as string) ?? '';
  return resolveOtpAccountCoreDataContextByIdentifier(c.env, {
    tenantId,
    ...input,
  });
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
