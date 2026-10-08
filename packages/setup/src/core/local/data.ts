/**
 * Local data layer: schema, bootstrap rows and signed registries.
 *
 * Every step reuses the Cloudflare bootstrap code (SQL builders, signers, topology registration)
 * and only swaps the executor by passing a `LocalWranglerTarget`. The order matches the Cloudflare
 * initial deployment so the runtime sees the same invariants:
 *
 *   migrations -> shard identity -> Control topology -> tenant/admin/profile seeds
 *   -> notification routes -> signed runtime snapshot -> Lookup registries -> setup token
 */

import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  buildLookupHmacKeyStateGenerationKey,
  buildLookupHmacKeyStateSnapshotKey,
  signLookupHmacKeyState,
} from '@authrim/ar-lib-core/services/lookup-directory/hmac-key-state';
import {
  buildLookupShardRegistryGenerationKey,
  buildLookupShardRegistrySnapshotKey,
  signLookupShardRegistry,
} from '@authrim/ar-lib-core/services/lookup-directory/shard-registry';
import { LOOKUP_VIRTUAL_BUCKET_COUNT } from '@authrim/ar-lib-core/services/lookup-directory/contract';
import type { AuthrimConfig } from '../config.js';
import type { AuthrimLock } from '../lock.js';
import {
  AUTHRIM_MIGRATIONS_TABLE_SQL,
  buildPluginRunnerRegistryGenerationKey,
  buildPluginRunnerRegistrySnapshotKey,
  PLUGIN_RUNNER_REGISTRY_MAX_TTL_SECONDS,
  signPluginRunnerRegistry,
  type PluginRunnerRegistryShard,
} from '@authrim/ar-lib-core/control-plane';
import {
  buildRecordMigrationWithChecksumSql,
  ensureInitialAdminRolesInD1,
  ensureInitialTenantInD1,
  executeD1Command,
  executeD1Migration,
  findMigrationsRoot,
  getOptionalKVKeyByNamespaceId,
  putKVKeyByNamespaceId,
  queryD1Rows,
  seedDefaultCanonicalCatalog,
  seedRuntimeProfiles,
  type LocalWranglerTarget,
} from '../cloudflare.js';
import {
  buildControlPlaneShardMetadataSql,
  buildInitialControlPlaneResourcePlans,
  publishInitialControlPlaneRuntimeSnapshot,
  type InitialControlPlaneResourcePlan,
} from '../control-plane-bootstrap.js';
import { registerInitialControlTopology } from '../control-bootstrap-handoff.js';
import { lookupHmacKeyFingerprint, initializeControlKeyState } from '../control-key-state.js';
import {
  compileControlWorkerInventoryFromArtifacts,
  registerControlWorkerInventory,
} from '../control-worker-inventory.js';
import { publishAndActivateMigrationRelease } from '../migration-release-publication.js';
import { CORE_WORKER_COMPONENTS } from '../naming.js';
import { generateWranglerConfig, toToml } from '../wrangler.js';
import { createLocalD1BatchExecutor } from './d1-batch.js';
import { buildLocalResourceIds } from './wrangler-files.js';
import { ensureLocalLogNotificationConfiguration } from '../notification-provider-bootstrap.js';
import { renderPortableMigrationSql } from '../sql-portability.js';
import {
  loadTargetReleaseMigrationManifest,
  streamDirectory,
  type ReleaseMigrationManifest,
} from '../release-migrations.js';
import { getRootProductVersion } from '../version.js';
import type { LocalEnvironmentPaths } from './paths.js';

/** Local has no Control Worker to refresh signed snapshots, so they live as long as Lookup state. */
export const LOCAL_SIGNED_STATE_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOCAL_SETUP_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export function createLocalTarget(paths: LocalEnvironmentPaths): LocalWranglerTarget {
  return { configPath: paths.seedConfig, persistTo: paths.state, cwd: paths.rootDir };
}

export interface LocalRelease {
  migrationsRoot: string;
  manifest: ReleaseMigrationManifest;
  draft: boolean;
}

export async function loadLocalRelease(rootDir: string): Promise<LocalRelease> {
  const migrationsRoot = await findMigrationsRoot(rootDir, undefined, { strictRoot: true });
  if (!migrationsRoot.path) {
    throw new Error(
      `Migrations directory not found. Searched: ${migrationsRoot.searchPaths.join(', ')}`
    );
  }
  const productVersion = await getRootProductVersion(rootDir);
  const release = loadTargetReleaseMigrationManifest({
    migrationsRoot: migrationsRoot.path,
    productVersion,
    allowDraft: true,
  });
  return { migrationsRoot: migrationsRoot.path, manifest: release.manifest, draft: release.draft };
}

type StreamId = 'core-d1' | 'pii-d1' | 'admin-d1' | 'control-d1' | 'lookup-d1' | 'plugin-runner-d1';

/** Migration stream for each database binding (tenant shards use the bootstrap plans). */
export function streamForLocalBinding(
  binding: string,
  plans: readonly InitialControlPlaneResourcePlan[]
): StreamId {
  const plan = plans.find((candidate) => candidate.binding === binding);
  if (plan) return plan.migrationStreamId;
  switch (binding) {
    case 'DB':
      return 'core-d1';
    case 'DB_PII':
      return 'pii-d1';
    case 'DB_ADMIN':
      return 'admin-d1';
    case 'CONTROL_DB':
      return 'control-d1';
    case 'LOOKUP_DB':
      return 'lookup-d1';
    case 'PLUGIN_RUNNER_DB':
      return 'plugin-runner-d1';
    default:
      throw new Error(`local_database_stream_unknown:${binding}`);
  }
}

/**
 * Apply one stream to one database as a single script: tracking table, then every file in manifest
 * order, each followed by its history row. Local state is disposable, so one execution per
 * database replaces the per-file resume logic the Cloudflare flow needs.
 */
export async function buildLocalMigrationScript(input: {
  migrationsRoot: string;
  manifest: ReleaseMigrationManifest;
  streamId: StreamId;
  now?: number;
}): Promise<string> {
  const stream = input.manifest.streams.find((candidate) => candidate.id === input.streamId);
  const directory = streamDirectory(input.migrationsRoot, input.streamId);
  if (!stream || !directory)
    throw new Error(`release_migration_stream_not_found:${input.streamId}`);
  const parts = [`${AUTHRIM_MIGRATIONS_TABLE_SQL};`];
  for (const file of stream.files) {
    const source = await readFile(join(directory, file.path), 'utf-8');
    parts.push(renderPortableMigrationSql(source, 'sqlite').trimEnd());
    parts.push(
      buildRecordMigrationWithChecksumSql({
        filename: file.path,
        checksum: file.checksum,
        executionTimeMs: null,
        setupVersion: input.manifest.productVersion,
        ...(input.now === undefined ? {} : { appliedAt: input.now }),
      })
    );
  }
  return `${parts.join('\n\n')}\n`;
}

export async function applyLocalMigrations(input: {
  paths: LocalEnvironmentPaths;
  lock: AuthrimLock;
  release: LocalRelease;
  plans: readonly InitialControlPlaneResourcePlan[];
  onProgress?: (message: string) => void;
}): Promise<void> {
  const target = createLocalTarget(input.paths);
  const scratch = join(input.paths.root, 'tmp');
  await mkdir(scratch, { recursive: true });
  try {
    // Sequential on purpose: every wrangler process also writes Miniflare's shared
    // metadata.sqlite, and concurrent writers fail with SQLITE_READONLY.
    for (const [binding, database] of Object.entries(input.lock.d1)) {
      const streamId = streamForLocalBinding(binding, input.plans);
      input.onProgress?.(`  ${binding} <- ${streamId}`);
      const script = await buildLocalMigrationScript({
        migrationsRoot: input.release.migrationsRoot,
        manifest: input.release.manifest,
        streamId,
      });
      const scriptPath = join(scratch, `${binding}.sql`);
      await writeFile(scriptPath, script, { mode: 0o600 });
      const result = await executeD1Migration(database.name, scriptPath, undefined, { target });
      if (!result.success) {
        throw new Error(`Migration of ${binding} (${streamId}) failed: ${result.error}`);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function kvId(lock: AuthrimLock, binding: string): string {
  const id = lock.kv[binding]?.id;
  if (!id) throw new Error(`local_kv_missing:${binding}`);
  return id;
}

function d1Id(lock: AuthrimLock, binding: string): string {
  const id = lock.d1[binding]?.id;
  if (!id) throw new Error(`local_d1_missing:${binding}`);
  return id;
}

/** Initial rows and signed state, in Cloudflare order. */
export async function seedLocalEnvironment(input: {
  env: string;
  config: AuthrimConfig;
  lock: AuthrimLock;
  paths: LocalEnvironmentPaths;
  release: LocalRelease;
  onProgress?: (message: string) => void;
}): Promise<{ plans: InitialControlPlaneResourcePlan[] }> {
  const { env, config, lock, paths, release, onProgress } = input;
  const target = createLocalTarget(paths);
  const tenantId = config.tenant.name;
  const plans = buildInitialControlPlaneResourcePlans({
    env,
    lock,
    release: release.manifest,
    releaseDraft: release.draft,
  });

  onProgress?.('Registering tenant shard identities...');
  for (const plan of plans.filter((candidate) => candidate.role !== 'lookup')) {
    const lastFilename = plan.migrationFiles.at(-1)?.path;
    if (!lastFilename) throw new Error('initial_control_plane_migration_files_empty');
    await executeD1Command(plan.databaseId, buildControlPlaneShardMetadataSql(plan, lastFilename), {
      target,
    });
  }

  onProgress?.('Seeding Control tables (CONTROL_DB)...');
  await seedLocalControlPlane({ env, config, lock, paths, release, onProgress });
  await registerInitialControlTopology({
    environmentId: env,
    tenantId,
    controlDatabaseName: d1Id(lock, 'CONTROL_DB'),
    lock,
    release: release.manifest,
    releaseDraft: release.draft,
    automaticProvisioning: false,
    placementPolicy: config.tenant.placementPolicy,
    execute: (database, sql, options) => executeD1Command(database, sql, { ...options, target }),
    query: (database, sql) => queryD1Rows(database, sql, { target }),
  });

  onProgress?.('Activating the bootstrap topology (Control reconciliation, done directly)...');
  await executeD1Command(d1Id(lock, 'CONTROL_DB'), buildLocalControlActivationSql(env), {
    target,
  });

  const coreIdentifier = d1Id(lock, 'DB');
  onProgress?.('Seeding initial tenant, admin roles and profiles...');
  const tenant = await ensureInitialTenantInD1(env, config, undefined, {
    databaseIdentifier: coreIdentifier,
    target,
  });
  if (!tenant.success) throw new Error(`Initial tenant bootstrap failed: ${tenant.error}`);
  const roles = await ensureInitialAdminRolesInD1(env, config, undefined, {
    databaseIdentifier: d1Id(lock, 'DB_ADMIN'),
    target,
  });
  if (!roles.success) throw new Error(`Admin role bootstrap failed: ${roles.error}`);
  const catalog = await seedDefaultCanonicalCatalog(env, config, undefined, {
    databaseIdentifier: d1Id(lock, 'DB_ADMIN'),
    target,
  });
  if (!catalog.success) throw new Error(`Canonical catalog seed failed: ${catalog.error}`);
  const profiles = await seedRuntimeProfiles(env, config, undefined, {
    databaseIdentifier: coreIdentifier,
    target,
  });
  if (!profiles.success) throw new Error(`Runtime profile seed failed: ${profiles.error}`);

  onProgress?.('Routing notifications to the local log provider...');
  await ensureLocalLogNotificationConfiguration({
    environmentId: env,
    config,
    lock,
    execute: (database, sql, options) => executeD1Command(database, sql, { ...options, target }),
    query: (database, sql) => queryD1Rows(database, sql, { target }),
    putKv: (namespaceId, key, value, options) =>
      putKVKeyByNamespaceId(namespaceId, key, value, { ...options, target }),
  });

  await refreshLocalSignedState({ env, config, lock, paths, release, plans, onProgress });
  await ensureLocalSetupToken({ lock, paths, onProgress });
  return { plans };
}

/**
 * Control tables the data plane's bootstrap code expects: the active migration release, the
 * environment and desired Worker inventory, and the signing/Lookup key state. Nothing runs
 * against them locally (the Control Worker is not started); they exist so the topology that
 * follows, and the region config derived from it, have the same foundations as in the cloud.
 */
async function seedLocalControlPlane(input: {
  env: string;
  config: AuthrimConfig;
  lock: AuthrimLock;
  paths: LocalEnvironmentPaths;
  release: LocalRelease;
  onProgress?: (message: string) => void;
}): Promise<void> {
  const { env, config, lock, paths, release } = input;
  const target = createLocalTarget(paths);
  const executeBatch = createLocalD1BatchExecutor(target);
  const controlDatabase = d1Id(lock, 'CONTROL_DB');

  await publishAndActivateMigrationRelease({
    migrationsRoot: release.migrationsRoot,
    manifest: release.manifest,
    draft: release.draft,
    bucketName: 'local-no-r2',
    controlDatabaseId: controlDatabase,
    environmentId: env,
    actorId: 'setup:local',
    upload: async () => undefined,
    executeBatch,
    verifyBucketOwnership: undefined,
  });

  // The inventory is compiled from cloud-shaped artifacts so it describes what each Worker needs,
  // not how the local session happens to run it.
  const artifactsDir = join(paths.root, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  const resourceIds = buildLocalResourceIds(lock, config);
  const artifactPaths: string[] = [];
  for (const component of CORE_WORKER_COMPONENTS) {
    const artifactPath = join(artifactsDir, `${component}.toml`);
    await writeFile(
      artifactPath,
      toToml(generateWranglerConfig(component, config, resourceIds), env)
    );
    artifactPaths.push(artifactPath);
  }
  const inventory = await compileControlWorkerInventoryFromArtifacts({
    baseDir: paths.rootDir,
    environmentId: env,
    environmentName: env,
    components: CORE_WORKER_COMPONENTS,
    artifactPaths,
  });
  await registerControlWorkerInventory({
    controlDatabaseName: controlDatabase,
    records: inventory,
    environmentBootstrap: {
      defaultResidencyPolicyId: config.profiles.defaults.residency,
      automaticProvisioning: false,
    },
    registeredBy: 'setup:local',
    execute: (database, sql, options) => executeD1Command(database, sql, { ...options, target }),
  });
  await rm(artifactsDir, { recursive: true, force: true });

  await initializeControlKeyState({
    controlDatabaseId: controlDatabase,
    environmentId: env,
    keysDir: paths.keys,
    actorId: 'setup:local',
    executeBatch,
  });
}

const SIGNED_AT_FILE = 'signed-at';
/** Re-sign when the previous publication is older than this (the plugin registry lives 24h). */
export const LOCAL_SIGNED_STATE_REFRESH_AFTER_SECONDS = 12 * 60 * 60;

/**
 * (Re)publish everything Control would keep fresh in the cloud: the signed runtime registry
 * snapshot, the Lookup shard registry and the Lookup HMAC key state.
 */
export async function refreshLocalSignedState(input: {
  env: string;
  config: AuthrimConfig;
  lock: AuthrimLock;
  paths: LocalEnvironmentPaths;
  release: LocalRelease;
  plans: readonly InitialControlPlaneResourcePlan[];
  onProgress?: (message: string) => void;
}): Promise<void> {
  input.onProgress?.('Publishing signed runtime registry...');
  const published = await publishInitialControlPlaneRuntimeSnapshot({
    env: input.env,
    config: input.config,
    lock: input.lock,
    rootDir: input.paths.rootDir,
    keysDir: input.paths.keys,
    release: input.release.manifest,
    target: createLocalTarget(input.paths),
    snapshotTtlSeconds: LOCAL_SIGNED_STATE_TTL_SECONDS,
  });
  if (!published.success) {
    throw new Error(`Runtime registry publication failed: ${published.error}`);
  }
  await publishLocalControlRegistries({
    env: input.env,
    lock: input.lock,
    paths: input.paths,
    plans: input.plans,
  });
  await writeFile(join(input.paths.root, SIGNED_AT_FILE), `${Math.floor(Date.now() / 1000)}\n`);
}

export async function localSignedStateNeedsRefresh(
  paths: LocalEnvironmentPaths,
  now: number = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  try {
    const signedAt = Number.parseInt(await readFile(join(paths.root, SIGNED_AT_FILE), 'utf-8'), 10);
    return !Number.isFinite(signedAt) || now - signedAt > LOCAL_SIGNED_STATE_REFRESH_AFTER_SECONDS;
  } catch {
    return true;
  }
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

/**
 * The state transitions Control's reconciler performs once the bootstrap Workers are verified:
 * shards become active and capacity-eligible, the bootstrap handoff is accepted and the
 * environment becomes active. Control cannot verify Workers through the Cloudflare API locally,
 * and runtime account allocation refuses shards that are not active, so setup records the
 * outcome directly. Mirrors `BootstrapHandoffRepository.accept` and the worker-binding
 * reconciliation completion in ar-control.
 */
export function buildLocalControlActivationSql(env: string, now?: number): string {
  const at = now ?? Math.floor(Date.now() / 1000);
  const environment = sqlLiteral(env);
  return [
    `UPDATE control_tenant_shards SET status = 'active', updated_at = ${at}
      WHERE environment_id = ${environment} AND status = 'ready';`,
    `UPDATE control_lookup_physical_shards SET status = 'active', updated_at = ${at}
      WHERE environment_id = ${environment} AND status = 'ready';`,
    `INSERT OR IGNORE INTO control_shard_capacity (
       shard_id, target_account_count, allocated_account_count,
       health_status, allocation_status, checked_at, updated_at
     )
     SELECT shard.shard_id, policy.target_account_count,
            (SELECT COUNT(*) FROM control_tenant_shard_allocations allocation
              WHERE allocation.selected_shard_id = shard.shard_id
                AND allocation.reservation_state IN ('reserved', 'committed')
                AND allocation.capacity_counted_at IS NOT NULL) +
            (SELECT COUNT(*) FROM control_tenant_default_allocations allocation
              WHERE allocation.selected_shard_id = shard.shard_id
                AND allocation.reservation_state IN ('reserved', 'committed')
                AND allocation.capacity_counted_at IS NOT NULL),
            'healthy', 'eligible', ${at}, ${at}
       FROM control_tenant_shards shard
       JOIN control_environment_resource_policies policy
         ON policy.environment_id = shard.environment_id
      WHERE shard.environment_id = ${environment} AND shard.status = 'active';`,
    `UPDATE control_bootstrap_handoffs
        SET state = 'accepted', verification_error_code = NULL,
            verified_at = ${at}, accepted_at = ${at}, updated_at = ${at}
      WHERE environment_id = ${environment};`,
    `UPDATE control_environments SET lifecycle_state = 'active', updated_at = ${at}
      WHERE environment_id = ${environment} AND lifecycle_state = 'creating';`,
  ].join('\n');
}

async function readSigningKey(
  keysDir: string
): Promise<{ jwk: Record<string, unknown>; keyId: string }> {
  const jwk = JSON.parse(
    await readFile(join(keysDir, 'tenant_runtime_registry_signing_private.jwk.json'), 'utf-8')
  ) as Record<string, unknown>;
  const keyId = (
    await readFile(join(keysDir, 'tenant_runtime_registry_signing_key_id.txt'), 'utf-8').catch(
      () => ''
    )
  ).trim();
  const resolved = keyId || (typeof jwk.kid === 'string' ? jwk.kid : '');
  if (!resolved) throw new Error('runtime_registry_signing_key_id_required');
  return { jwk, keyId: resolved };
}

/**
 * The registries Control signs and refreshes from CONTROL_DB in the cloud: the Lookup shard
 * registry, the Lookup HMAC key state and the plugin-runner registry. Locally one signing pass
 * (repeated by `local up`) replaces Control's cron.
 */
export async function publishLocalControlRegistries(input: {
  env: string;
  lock: AuthrimLock;
  paths: LocalEnvironmentPaths;
  plans: readonly InitialControlPlaneResourcePlan[];
  now?: number;
}): Promise<void> {
  const target = createLocalTarget(input.paths);
  const lookup = input.plans.find((plan) => plan.role === 'lookup');
  if (!lookup?.lookupShardId) throw new Error('local_lookup_plan_missing');
  const signing = await readSigningKey(input.paths.keys);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const expiresAt = now + LOCAL_SIGNED_STATE_TTL_SECONDS;
  const namespaceId = kvId(input.lock, 'TENANT_RUNTIME_REGISTRY');
  const privateJwk = signing.jwk as Parameters<typeof signLookupShardRegistry>[0]['privateJwk'];

  const registry = await signLookupShardRegistry({
    registry: {
      environmentId: input.env,
      generation: now,
      issuedAt: now,
      expiresAt,
      ranges: [
        {
          startBucket: 0,
          endBucket: LOOKUP_VIRTUAL_BUCKET_COUNT - 1,
          assignmentGeneration: 1,
          lookupShardId: lookup.lookupShardId,
          bindingRef: 'LOOKUP_DB',
        },
      ],
    },
    privateJwk,
  });
  const lookupSecret = await readFile(
    join(input.paths.keys, 'lookup_hmac_key_slot_a.txt'),
    'utf-8'
  );
  const fingerprint = lookupHmacKeyFingerprint(lookupSecret);
  const digest = createHash('sha256').update([fingerprint, signing.keyId].join('\0')).digest('hex');
  const hmacState = await signLookupHmacKeyState({
    state: {
      environmentId: input.env,
      generation: now,
      issuedAt: now,
      expiresAt,
      rotationState: 'stable',
      writeMode: 'current_only',
      current: {
        generation: 1,
        keyId: `lookup-${digest.slice(0, 16)}-g1`,
        slot: 'A',
        fingerprint,
      },
      previous: null,
    },
    privateJwk,
  });

  // Plugin-runner registry: the tenant shards the notification dispatcher may write to. It is
  // limited to 24 hours, which is why signed state is refreshed more often than it expires.
  const shardRows = await queryD1Rows<{
    shard_id: string;
    binding_ref: string;
    data_role: string;
    residency_partition: string;
    generation: number | string;
  }>(
    d1Id(input.lock, 'CONTROL_DB'),
    `SELECT shard_id, binding_ref, data_role, residency_partition, generation
       FROM control_tenant_shards
      WHERE environment_id = ${sqlLiteral(input.env)} AND status = 'active'
        AND data_role IN ('tenant_core/default', 'tenant_core/users')
      ORDER BY shard_id`,
    { target }
  );
  const pluginRunnerRegistry = await signPluginRunnerRegistry({
    registry: {
      environmentId: input.env,
      generation: now,
      issuedAt: now,
      expiresAt: now + PLUGIN_RUNNER_REGISTRY_MAX_TTL_SECONDS,
      shards: shardRows.map(
        (row): PluginRunnerRegistryShard => ({
          shardId: row.shard_id,
          bindingRef: row.binding_ref,
          dataRole: row.data_role as PluginRunnerRegistryShard['dataRole'],
          residencyPartition: row.residency_partition,
          routeGeneration: Number(row.generation),
        })
      ),
    },
    privateJwk,
  });

  const writes: Array<[string, string]> = [
    [buildPluginRunnerRegistrySnapshotKey(input.env), pluginRunnerRegistry],
    [buildPluginRunnerRegistryGenerationKey(input.env), String(now)],
    [buildLookupShardRegistrySnapshotKey(input.env), registry],
    [buildLookupShardRegistryGenerationKey(input.env), String(now)],
    [buildLookupHmacKeyStateSnapshotKey(input.env), hmacState],
    [buildLookupHmacKeyStateGenerationKey(input.env), String(now)],
  ];
  for (const [key, value] of writes) {
    await putKVKeyByNamespaceId(namespaceId, key, value, {
      expirationTtl: LOCAL_SIGNED_STATE_TTL_SECONDS,
      target,
    });
  }
}

/** Issue the initial-admin setup token unless the admin has already been created. */
export async function ensureLocalSetupToken(input: {
  lock: AuthrimLock;
  paths: LocalEnvironmentPaths;
  onProgress?: (message: string) => void;
}): Promise<{ token: string | null }> {
  const target = createLocalTarget(input.paths);
  const namespaceId = kvId(input.lock, 'AUTHRIM_CONFIG');
  const completed = await getOptionalKVKeyByNamespaceId(namespaceId, 'setup:completed', target);
  if (completed === 'true') return { token: null };
  const token = (await readFile(join(input.paths.keys, 'setup_token.txt'), 'utf-8')).trim();
  await putKVKeyByNamespaceId(namespaceId, 'setup:token', token, {
    expirationTtl: LOCAL_SETUP_TOKEN_TTL_SECONDS,
    target,
  });
  return { token };
}
