import type { D1Database } from '@cloudflare/workers-types';
import { CompactSign, compactVerify, decodeProtectedHeader } from 'jose';
import {
  createLookupBlindIndexes,
  isValidPersistedUserId,
  loadVerifiedLookupBucketAssignmentProvider,
  LookupRouteResolver,
  resolveTenantAssignedDatabaseSourcesFromRegistry,
  validateAccountDirectoryPublication,
  validateCrossShardAccountCursor,
  type AccountDirectoryPublication,
  type CrossShardAccountCursor,
  type Env,
  type ResolvedTenantDatabaseSource,
} from '@authrim/ar-lib-core';
import { loadLookupHmacRuntimeKeys } from './lookup-hmac-runtime';

const MAX_SHARDS = 32;
const MAX_LIMIT = 100;
const FANOUT_CONCURRENCY = 4;
const CURSOR_TTL_SECONDS = 15 * 60;
const CURSOR_TYPE = 'authrim-cross-shard-account-list+jws';
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;

export interface CrossShardAccountListInput {
  tenantId: string;
  limit?: number;
  cursor?: string;
  accountType?: string;
}

export interface CrossShardAccountListItem {
  id: string;
  legacyUserId: string;
  tenantId: string;
  accountType: string;
  lifecycleState: string;
  displayLabel: string | null;
  createdAt: number;
  coreBindingRef: string;
  piiBindingRef: string;
}

export interface CrossShardAccountListPage {
  items: CrossShardAccountListItem[];
  nextCursor: string | null;
}

interface AccountRow {
  id: string;
  legacy_user_id: string;
  tenant_id: string;
  account_type: string;
  lifecycle_state: string;
  display_label: string | null;
  created_at: number;
  account_route_generation: number;
  payload_json: string;
}

interface Candidate extends CrossShardAccountListItem {
  shardId: string;
}

interface LocalCursor {
  createdAt: number;
  id: string;
}

function d1Source(source: ResolvedTenantDatabaseSource['source']): D1Database {
  if (!source || typeof source !== 'object') {
    throw new Error('cross_shard_account_binding_unavailable');
  }
  const candidate = source as Partial<D1Database>;
  if (typeof candidate.withSession !== 'function' || typeof candidate.prepare !== 'function') {
    throw new Error('cross_shard_account_binding_unavailable');
  }
  return source as D1Database;
}

function cursorKey(secret: string | undefined): Uint8Array {
  if (!secret || new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error('cross_shard_cursor_signing_key_unavailable');
  }
  return new TextEncoder().encode(secret);
}

function localCursor(value: string | null): LocalCursor | null {
  if (value === null) return null;
  if (value.length > 512) throw new Error('invalid_shard_cursor');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error('invalid_shard_cursor');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid_shard_cursor');
  }
  const row = parsed as Record<string, unknown>;
  if (
    !Number.isSafeInteger(row.createdAt) ||
    (row.createdAt as number) < 0 ||
    typeof row.id !== 'string' ||
    !SAFE_ID.test(row.id)
  ) {
    throw new Error('invalid_shard_cursor');
  }
  return { createdAt: row.createdAt as number, id: row.id };
}

function encodeLocalCursor(item: CrossShardAccountListItem): string {
  return JSON.stringify({ createdAt: item.createdAt, id: item.id });
}

async function digestHex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function queryHash(input: { tenantId: string; accountType: string | null }): Promise<string> {
  return digestHex(
    JSON.stringify({
      tenantId: input.tenantId,
      accountType: input.accountType,
      publicationState: 'active',
      lifecycleState: 'active',
      sort: 'created_at_desc,id_desc',
    })
  );
}

async function shardSetGeneration(shards: ActiveAccountShard[]): Promise<number> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify(
        shards.map((shard) => [
          shard.shardId,
          shard.bindingRef,
          shard.residencyPartition,
          shard.routeGeneration,
        ])
      )
    )
  );
  const bytes = new Uint8Array(digest);
  let generation = 0;
  for (let index = 0; index < 6; index += 1) generation = generation * 256 + bytes[index];
  return generation || 1;
}

async function encodeCursor(cursor: CrossShardAccountCursor, secret: string): Promise<string> {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(cursor)))
    .setProtectedHeader({ alg: 'HS256', typ: CURSOR_TYPE })
    .sign(cursorKey(secret));
}

async function decodeCursor(token: string, secret: string): Promise<CrossShardAccountCursor> {
  if (token.length > 16_384) throw new Error('invalid_cross_shard_cursor');
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    throw new Error('invalid_cross_shard_cursor');
  }
  if (
    header.alg !== 'HS256' ||
    header.typ !== CURSOR_TYPE ||
    Object.keys(header).some((key) => key !== 'alg' && key !== 'typ')
  ) {
    throw new Error('invalid_cross_shard_cursor');
  }
  let payload: Uint8Array;
  try {
    payload = (await compactVerify(token, cursorKey(secret))).payload;
  } catch {
    throw new Error('invalid_cross_shard_cursor');
  }
  try {
    return JSON.parse(new TextDecoder().decode(payload)) as CrossShardAccountCursor;
  } catch {
    throw new Error('invalid_cross_shard_cursor');
  }
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

interface ActiveAccountShard {
  dataRole: 'tenant_core/users' | 'tenant_pii';
  residencyPartition: string;
  shardId: string;
  bindingRef: string;
  routeGeneration: number;
  source: D1Database;
}

function validateRouteSources(
  value: ResolvedTenantDatabaseSource[],
  dataRole: ActiveAccountShard['dataRole']
): Map<string, ActiveAccountShard> {
  if (value.length > MAX_SHARDS) throw new Error('cross_shard_account_fanout_limit_exceeded');
  const result = new Map<string, ActiveAccountShard>();
  for (const resolved of value) {
    const shard: ActiveAccountShard = {
      dataRole,
      residencyPartition: resolved.residencyPartition,
      shardId: resolved.shardId,
      bindingRef: resolved.bindingRef,
      routeGeneration: resolved.bindingRouteGeneration,
      source: d1Source(resolved.source),
    };
    if (
      resolved.dataRole !== dataRole ||
      !SAFE_ID.test(shard.shardId) ||
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(shard.bindingRef) ||
      !Number.isSafeInteger(shard.routeGeneration) ||
      shard.routeGeneration < 1 ||
      result.has(shard.shardId)
    ) {
      throw new Error('cross_shard_account_source_invalid');
    }
    result.set(shard.shardId, shard);
  }
  return result;
}

async function activeRouteSources(
  env: Env,
  tenantId: string
): Promise<{
  core: Map<string, ActiveAccountShard>;
  pii: Map<string, ActiveAccountShard>;
}> {
  const [core, pii] = await Promise.all([
    resolveTenantAssignedDatabaseSourcesFromRegistry(env, {
      tenantId,
      role: 'tenant_core',
      dataRole: 'tenant_core/users',
      maxStores: MAX_SHARDS,
      concurrency: FANOUT_CONCURRENCY,
    }),
    resolveTenantAssignedDatabaseSourcesFromRegistry(env, {
      tenantId,
      role: 'tenant_pii',
      dataRole: 'tenant_pii',
      maxStores: MAX_SHARDS,
      concurrency: FANOUT_CONCURRENCY,
    }),
  ]);
  return {
    core: validateRouteSources(core, 'tenant_core/users'),
    pii: validateRouteSources(pii, 'tenant_pii'),
  };
}

async function validatedAccountRoute(input: {
  row: AccountRow;
  tenantId: string;
  coreShard: ActiveAccountShard;
  piiShards: ReadonlyMap<string, ActiveAccountShard>;
}): Promise<{ coreBindingRef: string; piiBindingRef: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(input.row.payload_json) as unknown;
  } catch {
    throw new Error('cross_shard_account_route_invalid');
  }
  let publication: AccountDirectoryPublication;
  try {
    publication = await validateAccountDirectoryPublication(raw as AccountDirectoryPublication);
  } catch {
    throw new Error('cross_shard_account_route_invalid');
  }
  if (
    publication.tenantId !== input.tenantId ||
    publication.accountId !== input.row.id ||
    publication.routeProjection.accountRouteGeneration !== input.row.account_route_generation
  ) {
    throw new Error('cross_shard_account_route_invalid');
  }
  const coreTargets = publication.routeProjection.targets.filter(
    (target) => target.dataRole === 'tenant_core/users'
  );
  const piiTargets = publication.routeProjection.targets.filter(
    (target) => target.dataRole === 'tenant_pii'
  );
  if (coreTargets.length !== 1 || piiTargets.length !== 1) {
    throw new Error('cross_shard_account_route_invalid');
  }
  const core = coreTargets[0];
  const pii = piiTargets[0];
  const activePii = input.piiShards.get(pii.shardId);
  if (
    core.shardId !== input.coreShard.shardId ||
    core.bindingRef !== input.coreShard.bindingRef ||
    core.residencyPartition !== input.coreShard.residencyPartition ||
    core.requiredBindingRouteGeneration > input.coreShard.routeGeneration ||
    !activePii ||
    pii.bindingRef !== activePii.bindingRef ||
    pii.residencyPartition !== activePii.residencyPartition ||
    pii.requiredBindingRouteGeneration > activePii.routeGeneration ||
    core.residencyPartition !== pii.residencyPartition
  ) {
    throw new Error('cross_shard_account_route_invalid');
  }
  return { coreBindingRef: core.bindingRef, piiBindingRef: pii.bindingRef };
}

export class CrossShardAccountListService {
  constructor(
    private readonly env: Env,
    private readonly now: () => number
  ) {}

  async list(input: CrossShardAccountListInput): Promise<CrossShardAccountListPage> {
    if (!SAFE_ID.test(input.tenantId)) throw new Error('invalid_cross_shard_account_tenant');
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new Error('invalid_cross_shard_account_limit');
    }
    const accountType = input.accountType?.trim() || null;
    if (accountType !== null && !SAFE_ID.test(accountType)) {
      throw new Error('invalid_cross_shard_account_type');
    }
    const sources = await activeRouteSources(this.env, input.tenantId);
    const piiShards = sources.pii;
    const sortedShards = [...sources.core.values()].sort((left, right) =>
      left.shardId.localeCompare(right.shardId)
    );
    if (
      sortedShards.some(
        (shard, index) =>
          !SAFE_ID.test(shard.shardId) ||
          !/^[A-Z][A-Z0-9_]{0,127}$/u.test(shard.bindingRef) ||
          !Number.isSafeInteger(shard.routeGeneration) ||
          shard.routeGeneration < 1 ||
          (index > 0 && sortedShards[index - 1].shardId === shard.shardId)
      )
    ) {
      throw new Error('cross_shard_account_source_invalid');
    }
    const now = this.now();
    const generation = await shardSetGeneration(sortedShards);
    const expectedQueryHash = await queryHash({ tenantId: input.tenantId, accountType });
    const secret = this.env.LOGGING_CURSOR_HMAC_SECRET;
    const decoded = input.cursor ? await decodeCursor(input.cursor, secret ?? '') : null;
    const cursor = decoded
      ? validateCrossShardAccountCursor(decoded, {
          tenantId: input.tenantId,
          shardSetGeneration: generation,
          queryHash: expectedQueryHash,
          now,
        })
      : null;
    const positions = new Map(
      (
        cursor?.shardCursors ??
        sortedShards.map((shard) => ({ shardId: shard.shardId, cursor: null }))
      ).map((position) => [position.shardId, position.cursor])
    );
    if (
      positions.size !== sortedShards.length ||
      sortedShards.some((shard) => !positions.has(shard.shardId))
    ) {
      throw new Error('cursor_stale');
    }
    const pages = await mapConcurrent(sortedShards, FANOUT_CONCURRENCY, async (shard) => {
      const position = localCursor(positions.get(shard.shardId) ?? null);
      const session = shard.source.withSession('first-unconstrained');
      const clauses = [
        `account.tenant_id = ?`,
        `account.lifecycle_state = 'active'`,
        `account.directory_publication_state = 'active'`,
        ...(accountType ? [`account.account_type = ?`] : []),
        ...(position
          ? [`(account.created_at < ? OR (account.created_at = ? AND account.id < ?))`]
          : []),
      ];
      const params: unknown[] = [
        input.tenantId,
        ...(accountType ? [accountType] : []),
        ...(position ? [position.createdAt, position.createdAt, position.id] : []),
        limit + 1,
      ];
      const response = await session
        .prepare(
          `SELECT account.id, account.legacy_user_id, account.tenant_id, account.account_type,
                  account.lifecycle_state, account.display_label, account.created_at,
                  account.account_route_generation, outbox.payload_json
             FROM identity_accounts account
             JOIN account_routing_outbox outbox
               ON outbox.tenant_id = account.tenant_id
              AND outbox.account_id = account.id
              AND outbox.event_kind = 'account_created'
              AND outbox.route_generation = account.account_route_generation
              AND outbox.status = 'succeeded'
            WHERE ${clauses.join(' AND ')}
            ORDER BY account.created_at DESC, account.id DESC LIMIT ?`
        )
        .bind(...params)
        .all<AccountRow>();
      if (response.results.length > limit + 1) {
        throw new Error('cross_shard_account_page_invalid');
      }
      return Promise.all(
        response.results.map<Promise<Candidate>>(async (row) => {
          if (
            row.tenant_id !== input.tenantId ||
            !SAFE_ID.test(row.id) ||
            !isValidPersistedUserId(row.legacy_user_id) ||
            !Number.isSafeInteger(row.created_at) ||
            row.created_at < 0
          ) {
            throw new Error('cross_shard_account_row_invalid');
          }
          const route = await validatedAccountRoute({
            row,
            tenantId: input.tenantId,
            coreShard: shard,
            piiShards,
          });
          return {
            id: row.id,
            legacyUserId: row.legacy_user_id,
            tenantId: row.tenant_id,
            accountType: row.account_type,
            lifecycleState: row.lifecycle_state,
            displayLabel: row.display_label,
            createdAt: row.created_at,
            coreBindingRef: route.coreBindingRef,
            piiBindingRef: route.piiBindingRef,
            shardId: shard.shardId,
          };
        })
      );
    });
    const candidates = pages
      .flat()
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    const selected = candidates.slice(0, limit);
    const nextPositions = new Map(positions);
    for (const item of selected) nextPositions.set(item.shardId, encodeLocalCursor(item));
    const hasMore = candidates.length > selected.length;
    const nextCursor = hasMore
      ? await encodeCursor(
          {
            schemaVersion: 1,
            tenantId: input.tenantId,
            shardSetGeneration: generation,
            queryHash: expectedQueryHash,
            issuedAt: now,
            expiresAt: now + CURSOR_TTL_SECONDS,
            shardCursors: sortedShards.map((shard) => ({
              shardId: shard.shardId,
              cursor: nextPositions.get(shard.shardId) ?? null,
            })),
          },
          secret ?? ''
        )
      : null;
    return {
      items: selected.map(({ shardId: _shardId, ...item }) => item),
      nextCursor,
    };
  }
}

interface ExactAccountRow extends AccountRow {
  directory_publication_state: string;
}

async function primaryAccountRow(
  target: { source: D1Database },
  tenantId: string,
  accountId: string,
  purpose: 'active_search' | 'account_delete_retry'
): Promise<ExactAccountRow | null> {
  const stateClause =
    purpose === 'account_delete_retry'
      ? `AND (
           (lifecycle_state = 'active' AND directory_publication_state = 'active') OR
           (lifecycle_state IN ('deleting', 'deleted') AND directory_publication_state = 'disabled')
         )`
      : "AND lifecycle_state = 'active' AND directory_publication_state = 'active'";
  return target.source
    .withSession('first-primary')
    .prepare(
      `SELECT id, legacy_user_id, tenant_id, account_type, lifecycle_state, display_label,
              created_at, account_route_generation, directory_publication_state, '' AS payload_json
         FROM identity_accounts
        WHERE tenant_id = ? AND id = ? ${stateClause}
        LIMIT 1`
    )
    .bind(tenantId, accountId)
    .first<ExactAccountRow>();
}

export class CrossShardAccountExactSearchService {
  constructor(private readonly env: Env) {}

  async find(input: {
    tenantId: string;
    identifier: string;
    purpose?: 'active_search' | 'account_delete_retry';
  }): Promise<CrossShardAccountListItem[]> {
    if (!SAFE_ID.test(input.tenantId) || input.identifier.length > 320) {
      throw new Error('invalid_cross_shard_account_search');
    }
    const environmentId = this.env.AUTHRIM_ENVIRONMENT_NAME;
    if (
      !environmentId ||
      !SAFE_ID.test(environmentId) ||
      !this.env.TENANT_RUNTIME_REGISTRY ||
      !this.env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS
    ) {
      throw new Error('cross_shard_account_lookup_registry_unavailable');
    }
    const identifier = input.identifier.trim();
    const indexKind = identifier.includes('@') ? 'email_exact' : 'account_id';
    const indexValue =
      indexKind === 'account_id' && !identifier.startsWith('account:')
        ? `account:${identifier}`
        : identifier;
    const indexes = await createLookupBlindIndexes(
      indexKind,
      indexValue,
      (await loadLookupHmacRuntimeKeys(this.env)).readKeys
    );
    const assignments = await loadVerifiedLookupBucketAssignmentProvider({
      store: this.env.TENANT_RUNTIME_REGISTRY,
      environmentId,
      publicJwks: this.env.TENANT_RUNTIME_REGISTRY_VERIFYING_PUBLIC_JWKS,
    });
    const resolver = new LookupRouteResolver(
      this.env as unknown as { [bindingRef: string]: unknown },
      assignments
    );
    const memberships = (await resolver.resolveMemberships({ indexes })).filter(
      (membership) => membership.tenantId === input.tenantId
    );
    if (memberships.length === 0) return [];
    if (memberships.length !== 1) throw new Error('cross_shard_account_search_ambiguous');
    const membership = memberships[0];
    const purpose = input.purpose ?? 'active_search';
    const sources = await activeRouteSources(this.env, input.tenantId);
    const observedBindingRouteGenerations = Object.fromEntries(
      [...sources.core.values(), ...sources.pii.values()].map((source) => [
        source.bindingRef,
        source.routeGeneration,
      ])
    );
    const destination: { account: ExactAccountRow | null } = { account: null };
    const core = await resolver.resolveTargetAndRevalidate({
      membership,
      dataRole: 'tenant_core/users',
      residencyPartition:
        membership.routeProjection.targets.find((target) => target.dataRole === 'tenant_core/users')
          ?.residencyPartition ?? '',
      observedBindingRouteGenerations,
      verifyAtDestination: async (target) => {
        destination.account = await primaryAccountRow(
          target,
          input.tenantId,
          membership.accountId,
          purpose
        );
        return destination.account !== null;
      },
    });
    const account = destination.account;
    if (!account) throw new Error('cross_shard_account_row_invalid');
    if (account.account_type !== 'user') return [];
    const piiResidency = membership.routeProjection.targets.find(
      (target) => target.dataRole === 'tenant_pii'
    )?.residencyPartition;
    if (!piiResidency) throw new Error('cross_shard_account_route_invalid');
    const pii = await resolver.resolveTargetAndRevalidate({
      membership,
      dataRole: 'tenant_pii',
      residencyPartition: piiResidency,
      observedBindingRouteGenerations,
      verifyAtDestination: async (target) => {
        const row = await target.source
          .withSession('first-primary')
          .prepare(
            purpose === 'account_delete_retry'
              ? `SELECT owner_id FROM identity_sensitive_values
                   WHERE tenant_id = ? AND owner_type = 'runtime_user' AND owner_id = ?
                 UNION ALL
                 SELECT id AS owner_id FROM users_pii_tombstone
                   WHERE tenant_id = ? AND id = ?
                 LIMIT 1`
              : `SELECT owner_id FROM identity_sensitive_values
                   WHERE tenant_id = ? AND owner_type = 'runtime_user' AND owner_id = ?
                     AND lifecycle_state = 'active' LIMIT 1`
          )
          .bind(
            input.tenantId,
            account!.legacy_user_id,
            ...(purpose === 'account_delete_retry' ? [input.tenantId, account!.legacy_user_id] : [])
          )
          .first<{ owner_id: string }>();
        return row?.owner_id === account!.legacy_user_id;
      },
    });
    return [
      {
        id: account.id,
        legacyUserId: account.legacy_user_id,
        tenantId: account.tenant_id,
        accountType: account.account_type,
        lifecycleState: account.lifecycle_state,
        displayLabel: account.display_label,
        createdAt: account.created_at,
        coreBindingRef: core.bindingRef,
        piiBindingRef: pii.bindingRef,
      },
    ];
  }
}
