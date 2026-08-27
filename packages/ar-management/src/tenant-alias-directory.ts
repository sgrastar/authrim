import {
  createLookupAliasIndex,
  resolveTenantDatabaseSourceFromRegistry,
  validateTenantAliasRouteProjection,
  type Env,
  type LookupAliasKind,
  type LookupAliasIndex,
  type TenantAliasRouteProjection,
} from '@authrim/ar-lib-core';
import type { D1DatabaseSession } from '@cloudflare/workers-types';
import { createLookupBucketWriteResolver } from './lookup-bucket-write-route';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;

type AliasLifecycle = 'pending' | 'active' | 'disabled';

interface AliasRow {
  tenant_id: string;
  route_schema_version: number | string;
  route_projection_json: string;
  tenant_lifecycle_state: string;
  runtime_route_status: string;
  lifecycle_state: string;
}

export interface TenantAliasDirectoryInput {
  tenantId: string;
  tenantCode: string;
  tenantSlug: string;
  routeProjection: TenantAliasRouteProjection;
  now?: number;
}

export interface TenantDiscoveryAliasDirectoryInput {
  tenantId: string;
  aliasKind: Exclude<LookupAliasKind, 'tenant_code' | 'tenant_slug' | 'environment_tenant'>;
  aliasValue: string;
  routeProjection: TenantAliasRouteProjection;
  now?: number;
}

export async function resolveTenantDiscoveryAliasDirectoryInput(
  env: Env,
  input: Pick<TenantDiscoveryAliasDirectoryInput, 'tenantId' | 'aliasKind' | 'aliasValue' | 'now'>
): Promise<TenantDiscoveryAliasDirectoryInput> {
  const store = await resolveTenantDatabaseSourceFromRegistry(env, {
    tenantId: input.tenantId,
    role: 'tenant_core',
    dataRole: 'tenant_core/default',
    shardGroup: 'default',
    shardIndex: 0,
  });
  return {
    ...input,
    routeProjection: {
      schemaVersion: 1,
      tenantRouteGeneration: store.bindingRouteGeneration,
      residencyPolicyId: store.residencyPolicyId,
      target: {
        dataRole: 'tenant_core/default',
        residencyPartition: store.residencyPartition,
        shardId: store.shardId,
        bindingRef: store.bindingRef,
        requiredBindingRouteGeneration: store.bindingRouteGeneration,
      },
    },
  };
}

interface PreparedAlias {
  index: LookupAliasIndex;
  projectionJson: string;
  uniqueOwner: boolean;
  reusable: boolean;
}

interface AliasWriteTarget extends PreparedAlias {
  session: D1DatabaseSession;
}

function lifecycleColumns(
  state: AliasLifecycle,
  activeRouteMigration: boolean
): {
  tenantLifecycleState: 'creating' | 'active' | 'disabled';
  runtimeRouteStatus: 'pending' | 'active' | 'disabled';
} {
  switch (state) {
    case 'pending':
      return {
        tenantLifecycleState: activeRouteMigration ? 'active' : 'creating',
        runtimeRouteStatus: 'pending',
      };
    case 'active':
      return { tenantLifecycleState: 'active', runtimeRouteStatus: 'active' };
    case 'disabled':
      return { tenantLifecycleState: 'disabled', runtimeRouteStatus: 'disabled' };
  }
}

function numeric(value: number | string, code: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(code);
  return parsed;
}

function canonicalProjection(value: TenantAliasRouteProjection): TenantAliasRouteProjection {
  const validated = validateTenantAliasRouteProjection(value);
  return {
    schemaVersion: validated.schemaVersion,
    tenantRouteGeneration: validated.tenantRouteGeneration,
    residencyPolicyId: validated.residencyPolicyId,
    target: {
      dataRole: 'tenant_core/default',
      residencyPartition: validated.target.residencyPartition,
      shardId: validated.target.shardId,
      bindingRef: validated.target.bindingRef,
      requiredBindingRouteGeneration: validated.target.requiredBindingRouteGeneration,
    },
  };
}

function decodeExistingProjection(value: string): TenantAliasRouteProjection {
  if (typeof value !== 'string' || value.length > 16_384) {
    throw new Error('tenant_alias_projection_invalid');
  }
  try {
    return canonicalProjection(JSON.parse(value) as TenantAliasRouteProjection);
  } catch {
    throw new Error('tenant_alias_projection_invalid');
  }
}

function assertTransition(
  existing: AliasRow | null,
  state: AliasLifecycle,
  projection: TenantAliasRouteProjection,
  projectionJson: string,
  activeRouteMigration: boolean,
  reusable: boolean
): void {
  if (!existing) {
    if (state !== 'pending') throw new Error('tenant_alias_not_prepared');
    return;
  }
  if (existing.lifecycle_state === 'disabled') {
    if (reusable && (state === 'pending' || state === 'disabled')) return;
    throw new Error('tenant_alias_lifecycle_terminal');
  }
  const existingGeneration = numeric(
    existing.route_schema_version,
    'tenant_alias_route_schema_version_invalid'
  );
  const existingProjection = decodeExistingProjection(existing.route_projection_json);
  if (existingGeneration !== existingProjection.schemaVersion) {
    throw new Error('tenant_alias_route_schema_version_invalid');
  }
  if (state === 'pending') {
    const initialRetry =
      existing.lifecycle_state === 'pending' &&
      projection.schemaVersion >= existingGeneration &&
      projection.tenantRouteGeneration >= existingProjection.tenantRouteGeneration &&
      (projection.tenantRouteGeneration > existingProjection.tenantRouteGeneration ||
        existing.route_projection_json === projectionJson);
    const placementMigration =
      activeRouteMigration &&
      existing.lifecycle_state === 'active' &&
      projection.schemaVersion >= existingGeneration &&
      projection.tenantRouteGeneration > existingProjection.tenantRouteGeneration;
    if (!initialRetry && !placementMigration) {
      throw new Error('tenant_alias_transition_invalid');
    }
    return;
  }
  if (existing.route_projection_json !== projectionJson) {
    throw new Error('tenant_alias_projection_changed_during_activation');
  }
  if (state === 'active' && !['pending', 'active'].includes(existing.lifecycle_state)) {
    throw new Error('tenant_alias_transition_invalid');
  }
}

async function preparedAliases(
  env: Env,
  input: TenantAliasDirectoryInput
): Promise<PreparedAlias[]> {
  if (!SAFE_ID.test(input.tenantId)) throw new Error('tenant_alias_tenant_id_invalid');
  const environmentId = env.AUTHRIM_ENVIRONMENT_NAME?.trim();
  if (!environmentId) throw new Error('tenant_alias_environment_id_missing');
  const projection = canonicalProjection(input.routeProjection);
  const projectionJson = JSON.stringify(projection);
  const [tenantCode, tenantSlug, environmentTenant] = await Promise.all([
    createLookupAliasIndex('tenant_code', input.tenantCode),
    createLookupAliasIndex('tenant_slug', input.tenantSlug),
    createLookupAliasIndex('environment_tenant', environmentId),
  ]);
  return [
    { index: tenantCode, projectionJson, uniqueOwner: true, reusable: false },
    { index: tenantSlug, projectionJson, uniqueOwner: true, reusable: false },
    { index: environmentTenant, projectionJson, uniqueOwner: false, reusable: false },
  ];
}

async function preparedDiscoveryAlias(
  input: TenantDiscoveryAliasDirectoryInput
): Promise<PreparedAlias[]> {
  if (!SAFE_ID.test(input.tenantId)) throw new Error('tenant_alias_tenant_id_invalid');
  const projectionJson = JSON.stringify(canonicalProjection(input.routeProjection));
  return [
    {
      index: await createLookupAliasIndex(input.aliasKind, input.aliasValue),
      projectionJson,
      uniqueOwner: input.aliasKind === 'invitation_token' || input.aliasKind === 'custom_domain',
      reusable: true,
    },
  ];
}

async function writePreparedAliases(
  env: Env,
  input: { tenantId: string; routeProjection: TenantAliasRouteProjection; now?: number },
  aliases: PreparedAlias[],
  state: AliasLifecycle,
  activeRouteMigration = false
): Promise<void> {
  const resolveBucket = await createLookupBucketWriteResolver(env);
  const databases = new Map<number, Awaited<ReturnType<typeof resolveBucket>>>();

  // Resolve every physical binding before the first mutation. This keeps a missing later bucket
  // from exposing only one of the tenant's aliases.
  await Promise.all(
    [...new Set(aliases.map(({ index }) => index.virtualBucket))].map(async (bucket) => {
      databases.set(bucket, await resolveBucket(bucket));
    })
  );

  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(now) || now < 1) throw new Error('tenant_alias_timestamp_invalid');
  const columns = lifecycleColumns(state, activeRouteMigration);
  const targets: AliasWriteTarget[] = [];

  for (const { index, projectionJson, uniqueOwner, reusable } of aliases) {
    const database = databases.get(index.virtualBucket);
    if (!database) throw new Error('tenant_alias_bucket_unavailable');
    const session = database.withSession('first-primary');
    if (uniqueOwner) {
      const live = await session
        .prepare(
          `SELECT tenant_id, route_schema_version, route_projection_json,
                  tenant_lifecycle_state, runtime_route_status, lifecycle_state
             FROM lookup_tenant_aliases
            WHERE virtual_bucket = ? AND alias_kind = ? AND alias_sha256_digest = ?
              AND lifecycle_state <> 'disabled'
            LIMIT 2`
        )
        .bind(index.virtualBucket, index.aliasKind, index.digest)
        .all<AliasRow>();
      if (live.results.length > 1) throw new Error('tenant_alias_live_owner_ambiguous');
      if (live.results[0] && live.results[0].tenant_id !== input.tenantId) {
        throw new Error('tenant_alias_already_owned');
      }
    }
    const existing = await session
      .prepare(
        `SELECT tenant_id, route_schema_version, route_projection_json,
                tenant_lifecycle_state, runtime_route_status, lifecycle_state
           FROM lookup_tenant_aliases
          WHERE virtual_bucket = ? AND alias_kind = ? AND alias_sha256_digest = ?
            AND tenant_id = ?
          LIMIT 1`
      )
      .bind(index.virtualBucket, index.aliasKind, index.digest, input.tenantId)
      .first<AliasRow>();
    assertTransition(
      existing,
      state,
      canonicalProjection(input.routeProjection),
      projectionJson,
      activeRouteMigration,
      reusable
    );
    targets.push({
      index,
      projectionJson,
      uniqueOwner,
      reusable,
      session,
    });
  }

  for (const { index, projectionJson, session } of targets) {
    if (state === 'active') {
      const publicationCounter = await session
        .prepare(`SELECT 1 AS present FROM lookup_bucket_counters WHERE virtual_bucket = ?`)
        .bind(index.virtualBucket)
        .first<{ present: number }>();
      if (publicationCounter?.present !== 1) {
        throw new Error('tenant_alias_publication_counter_missing');
      }
    }
    const aliasWrite = session
      .prepare(
        `INSERT INTO lookup_tenant_aliases (
           virtual_bucket, alias_kind, alias_sha256_digest, tenant_id,
           route_schema_version, route_projection_json, tenant_lifecycle_state,
           runtime_route_status, lifecycle_state, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(virtual_bucket, alias_kind, alias_sha256_digest, tenant_id) DO UPDATE SET
           route_schema_version = excluded.route_schema_version,
           route_projection_json = excluded.route_projection_json,
           tenant_lifecycle_state = excluded.tenant_lifecycle_state,
           runtime_route_status = excluded.runtime_route_status,
           lifecycle_state = excluded.lifecycle_state,
           updated_at = excluded.updated_at`
      )
      .bind(
        index.virtualBucket,
        index.aliasKind,
        index.digest,
        input.tenantId,
        input.routeProjection.schemaVersion,
        projectionJson,
        columns.tenantLifecycleState,
        columns.runtimeRouteStatus,
        state,
        now,
        now
      );
    const results = await session.batch([
      ...(state === 'active'
        ? [
            session
              .prepare(
                `UPDATE lookup_bucket_counters
                    SET successful_route_publication_count = successful_route_publication_count + 1,
                        publication_counter_updated_at = MAX(publication_counter_updated_at, ?)
                  WHERE virtual_bucket = ?
                    AND NOT EXISTS (
                      SELECT 1 FROM lookup_tenant_aliases
                       WHERE virtual_bucket = ? AND alias_kind = ?
                         AND alias_sha256_digest = ? AND tenant_id = ?
                         AND lifecycle_state = 'active'
                    )`
              )
              .bind(
                now,
                index.virtualBucket,
                index.virtualBucket,
                index.aliasKind,
                index.digest,
                input.tenantId
              ),
          ]
        : []),
      aliasWrite,
    ]);
    const result = results[results.length - 1];
    if (!result.success) {
      throw new Error('tenant_alias_write_failed');
    }

    const reflected = await session
      .prepare(
        `SELECT tenant_id, route_schema_version, route_projection_json,
                tenant_lifecycle_state, runtime_route_status, lifecycle_state
           FROM lookup_tenant_aliases
          WHERE virtual_bucket = ? AND alias_kind = ? AND alias_sha256_digest = ?
            AND tenant_id = ?
          LIMIT 1`
      )
      .bind(index.virtualBucket, index.aliasKind, index.digest, input.tenantId)
      .first<AliasRow>();
    if (
      !reflected ||
      reflected.tenant_id !== input.tenantId ||
      numeric(reflected.route_schema_version, 'tenant_alias_route_schema_version_invalid') !==
        input.routeProjection.schemaVersion ||
      reflected.route_projection_json !== projectionJson ||
      reflected.tenant_lifecycle_state !== columns.tenantLifecycleState ||
      reflected.runtime_route_status !== columns.runtimeRouteStatus ||
      reflected.lifecycle_state !== state
    ) {
      throw new Error('tenant_alias_reflection_failed');
    }
  }
}

async function writeTenantAliases(
  env: Env,
  input: TenantAliasDirectoryInput,
  state: AliasLifecycle,
  activeRouteMigration = false
): Promise<void> {
  return writePreparedAliases(
    env,
    input,
    await preparedAliases(env, input),
    state,
    activeRouteMigration
  );
}

async function writeTenantDiscoveryAlias(
  env: Env,
  input: TenantDiscoveryAliasDirectoryInput,
  state: AliasLifecycle
): Promise<void> {
  return writePreparedAliases(env, input, await preparedDiscoveryAlias(input), state);
}

export function prepareTenantAliasDirectory(
  env: Env,
  input: TenantAliasDirectoryInput
): Promise<void> {
  return writeTenantAliases(env, input, 'pending');
}

export function activateTenantAliasDirectory(
  env: Env,
  input: TenantAliasDirectoryInput
): Promise<void> {
  return writeTenantAliases(env, input, 'active');
}

export function prepareTenantAliasPlacementMigration(
  env: Env,
  input: TenantAliasDirectoryInput
): Promise<void> {
  return writeTenantAliases(env, input, 'pending', true);
}

export function disableTenantAliasDirectory(
  env: Env,
  input: TenantAliasDirectoryInput
): Promise<void> {
  return writeTenantAliases(env, input, 'disabled');
}

export function prepareTenantDiscoveryAliasDirectory(
  env: Env,
  input: TenantDiscoveryAliasDirectoryInput
): Promise<void> {
  return writeTenantDiscoveryAlias(env, input, 'pending');
}

export function activateTenantDiscoveryAliasDirectory(
  env: Env,
  input: TenantDiscoveryAliasDirectoryInput
): Promise<void> {
  return writeTenantDiscoveryAlias(env, input, 'active');
}

/**
 * Makes discovery alias publication retry-safe after the destination mutation has committed.
 * A pending row is activated directly; a missing or reusable disabled row is prepared and then
 * activated. Other failures (ownership, projection, signature, or storage failures) remain fatal.
 */
export async function ensureActiveTenantDiscoveryAliasDirectory(
  env: Env,
  input: TenantDiscoveryAliasDirectoryInput
): Promise<void> {
  try {
    await activateTenantDiscoveryAliasDirectory(env, input);
    return;
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code !== 'tenant_alias_not_prepared' && code !== 'tenant_alias_lifecycle_terminal') {
      throw error;
    }
  }
  await prepareTenantDiscoveryAliasDirectory(env, input);
  await activateTenantDiscoveryAliasDirectory(env, input);
}

export function disableTenantDiscoveryAliasDirectory(
  env: Env,
  input: TenantDiscoveryAliasDirectoryInput
): Promise<void> {
  return writeTenantDiscoveryAlias(env, input, 'disabled');
}
