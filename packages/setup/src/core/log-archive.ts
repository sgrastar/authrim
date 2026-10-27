import { createHash } from 'node:crypto';
import {
  assertLogArchiveTableLocations,
  inspectLogArchiveTable,
  logArchivePhysicalFingerprint,
  type IcebergLoadedTable,
} from '@authrim/ar-lib-logging/iceberg';
import {
  LOG_ARCHIVE_FIELDS,
  LOG_ARCHIVE_STREAM_SCHEMA,
} from '@authrim/ar-lib-logging/iceberg/schema';
import {
  assertLogArchiveImplemented,
  assertLogArchiveLockMatches,
  LOG_ARCHIVE_MAINTENANCE_POLICY_DIGEST,
  type LogArchiveConfig,
  type LogArchiveLock,
} from './log-archive-config.js';
import type {
  ProvisioningResourceCheckpoint,
  ProvisioningResourceIdentity,
} from './provisioning-intent.js';

export const LOG_ARCHIVE_SCHEMA_DIGEST = createHash('sha256')
  .update(JSON.stringify(LOG_ARCHIVE_FIELDS))
  .digest('hex');
const SQL_NAME = /^[a-z][a-z0-9_]{0,127}$/u;
const ACCOUNT_ID = /^[a-f0-9]{32}$/u;

export interface LogArchivePlan {
  schemaDigest: string;
  resources: ProvisioningResourceIdentity[];
  streamBody?: Record<string, unknown>;
  sinkBody?: Record<string, unknown>;
  pipelineBody?: Record<string, unknown>;
}

/** Pure plan: never requests credentials, creates resources, or changes billing. */
export function planLogArchive(environment: string, archive: LogArchiveConfig): LogArchivePlan {
  const stem = `${environment.replaceAll('-', '_')}_logs_${archive.storageGeneration.replaceAll('-', '')}`;
  if (!SQL_NAME.test(stem)) throw new Error('log_archive_resource_name_invalid');
  const resources: ProvisioningResourceIdentity[] = [
    { kind: 'r2', binding: 'LOG_ARCHIVE', name: archive.bucketName },
    { kind: 'catalog', binding: 'LOG_ARCHIVE_CATALOG', name: archive.bucketName },
  ];
  if (archive.mode === 'scheduled') return { schemaDigest: LOG_ARCHIVE_SCHEMA_DIGEST, resources };
  const stream = `${stem}_stream`;
  const sink = `${stem}_sink`;
  const pipeline = `${stem}_pipeline`;
  resources.push(
    { kind: 'stream', binding: 'LOG_ARCHIVE_STREAM', name: stream },
    { kind: 'sink', binding: 'LOG_ARCHIVE_SINK', name: sink },
    { kind: 'pipeline', binding: 'LOG_ARCHIVE_PIPELINE', name: pipeline }
  );
  return {
    schemaDigest: LOG_ARCHIVE_SCHEMA_DIGEST,
    resources,
    streamBody: {
      name: stream,
      format: { type: 'json', unstructured: false },
      http: { enabled: false, authentication: true },
      worker_binding: { enabled: true },
      schema: LOG_ARCHIVE_STREAM_SCHEMA,
    },
    // The API enum differs from Wrangler's current --type basin-catalog spelling.
    sinkBody: {
      name: sink,
      type: 'r2_data_catalog',
      schema: LOG_ARCHIVE_STREAM_SCHEMA,
      format: { type: 'parquet', compression: 'zstd' },
      config: {
        bucket: archive.bucketName,
        namespace: archive.namespace,
        table_name: archive.tableName,
        rolling_policy: { file_size_bytes: 100 * 1024 * 1024, interval_seconds: 300 },
      },
    },
    pipelineBody: { name: pipeline, sql: `INSERT INTO ${sink} SELECT * FROM ${stream}` },
  };
}

/** A D1/R2-only lock must never finish an interrupted archive setup. */
export function hasCompleteLogArchiveState(input: {
  environment: string;
  archive?: LogArchiveConfig;
  resource?: LogArchiveLock;
  checkpoints?: Readonly<Record<string, ProvisioningResourceCheckpoint>>;
}): boolean {
  if (!input.archive) return false;
  try {
    assertLogArchiveLockMatches(input.archive, input.resource);
  } catch {
    return false;
  }
  const locked = input.resource!;
  if (locked.schemaDigest !== LOG_ARCHIVE_SCHEMA_DIGEST) return false;
  if (!input.checkpoints) return true;
  const plan = planLogArchive(input.environment, input.archive);
  for (const identity of plan.resources.filter((resource) => resource.kind !== 'r2')) {
    const checkpoint = input.checkpoints[`${identity.kind}:${identity.binding}`];
    const resource =
      identity.kind === 'catalog'
        ? locked.catalog
        : identity.kind === 'stream'
          ? locked.stream
          : identity.kind === 'sink'
            ? locked.sink
            : locked.pipeline;
    if (
      !resource ||
      checkpoint?.state !== 'created' ||
      checkpoint.name !== identity.name ||
      checkpoint.id !== resource.id
    )
      return false;
    if (identity.kind !== 'catalog' && !checkpoint.configurationDigest) return false;
  }
  return true;
}

export class LogArchiveApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
  }
}

/** Does not retry mutations after an ambiguous response. The provisioning WAL owns recovery. */
export class LogArchiveApi {
  constructor(
    readonly accountId: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch
  ) {
    if (!ACCOUNT_ID.test(accountId) || !token.trim())
      throw new Error('log_archive_cloudflare_credentials_invalid');
  }

  async request<T>(path: string, method = 'GET', body?: unknown, token = this.token): Promise<T> {
    const response = await this.fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/${path}`,
      {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      }
    );
    if (response.status === 404)
      throw new LogArchiveApiError(404, 'log_archive_resource_not_found');
    if (response.status === 204 && response.ok) return undefined as T;
    let payload: { success?: boolean; result?: T };
    try {
      payload = (await response.json()) as { success?: boolean; result?: T };
    } catch {
      throw new LogArchiveApiError(response.status, 'log_archive_cloudflare_response_invalid');
    }
    if (
      !response.ok ||
      payload.success !== true ||
      (payload.result === undefined &&
        method !== 'DELETE' &&
        !path.split('?')[0].endsWith('/disable') &&
        !path.split('?')[0].endsWith('/delete'))
    ) {
      // Never interpolate the provider response: Sink errors can contain credentials.
      throw new LogArchiveApiError(
        response.status,
        response.status === 401 || response.status === 403
          ? 'log_archive_permission_or_subscription_required'
          : 'log_archive_cloudflare_request_failed'
      );
    }
    return payload.result as T;
  }

  async verifyCatalogCredentials(
    readToken: string,
    writeToken: string,
    sinkToken?: string
  ): Promise<void> {
    const groups = await this.request<Array<{ id: string; name: string }>>(
      'tokens/permission_groups?scope=com.cloudflare.api.account'
    );
    const groupNames = new Map(groups.map((group) => [group.id, group.name]));
    const tokenIds = new Set<string>();
    for (const [role, token] of [
      ['read', readToken],
      ['write', writeToken],
      ...(sinkToken ? [['write', sinkToken] as const] : []),
    ] as const) {
      const verified = await this.request<{ id: string; status: string }>(
        'tokens/verify',
        'GET',
        undefined,
        token
      );
      if (verified.status !== 'active' || !verified.id)
        throw new Error('log_archive_catalog_token_inactive');
      if (tokenIds.has(verified.id))
        throw new Error('log_archive_distinct_catalog_token_ids_required');
      tokenIds.add(verified.id);
      const record = await this.request<{
        policies: Array<{
          effect: string;
          permission_groups: Array<{ id: string; name?: string }>;
          resources: Record<string, string>;
        }>;
      }>(`tokens/${encodeURIComponent(verified.id)}`);
      const allowed = record.policies.filter((policy) => policy.effect === 'allow');
      if (
        allowed.length === 0 ||
        allowed.some(
          (policy) => !Object.keys(policy.resources).some((key) => key.includes(this.accountId))
        )
      )
        throw new Error('log_archive_catalog_token_account_mismatch');
      const permissions = allowed.flatMap((policy) =>
        policy.permission_groups.map((group) => group.name ?? groupNames.get(group.id) ?? 'unknown')
      );
      if (permissions.includes('unknown'))
        throw new Error('log_archive_catalog_token_permission_unknown');
      if (role === 'read') {
        if (
          permissions.some((name) => /write|edit|admin/iu.test(name)) ||
          !permissions.some((name) => /catalog.*read/iu.test(name)) ||
          !permissions.some((name) => /sql.*read/iu.test(name)) ||
          !permissions.some((name) => /r2.*storage.*read/iu.test(name))
        )
          throw new Error('log_archive_catalog_read_token_not_read_only');
      } else if (
        !permissions.some((name) => /catalog.*(?:write|edit)/iu.test(name)) ||
        !permissions.some((name) => /r2.*storage.*(?:write|edit)/iu.test(name))
      )
        throw new Error('log_archive_catalog_write_token_permission_missing');
    }
  }

  async requireWorkersPaid(): Promise<void> {
    const subscriptions =
      await this.request<Array<{ rate_plan?: { id?: string }; state?: string }>>('subscriptions');
    const accepted = new Set([
      'WORKERS_PAID',
      'PARTNERS_WORKERS_ENT',
      'PARTNERS_WORKERS_SS',
      'PARTNERS_WORKERS_BASIC',
    ]);
    if (
      !Array.isArray(subscriptions) ||
      !subscriptions.some(
        (subscription) =>
          accepted.has(subscription.rate_plan?.id?.toUpperCase() ?? '') &&
          ['paid', 'provisioned'].includes(subscription.state?.toLowerCase() ?? '')
      )
    ) {
      throw new Error('log_archive_workers_paid_required');
    }
  }
}

type RemoteResource = { id: string; name: string; [key: string]: unknown };
export interface LogArchiveProvisionOptions {
  environment: string;
  archive: LogArchiveConfig;
  api: LogArchiveApi;
  catalogReadToken: string;
  catalogWriteToken: string;
  catalogSinkToken?: string;
  checkpoints: Readonly<Record<string, ProvisioningResourceCheckpoint>>;
  checkpoint: (resource: ProvisioningResourceCheckpoint) => Promise<void>;
  /** R2 ownership must be verified with the existing marker + creation_date implementation. */
  assertBucketOwned: () => Promise<void>;
  /** The scheduled writer creates the table through the same Iceberg schema/client as runtime. */
  prepareScheduledTable: (catalog: { catalogUri: string; warehouse: string }) => Promise<void>;
  loadArchiveTable: () => Promise<IcebergLoadedTable>;
  onProgress?: (message: string) => void;
  readinessTimeoutMs?: number;
  waitForReadiness?: (milliseconds: number) => Promise<void>;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
function assertRemoteMatches(
  kind: string,
  remote: RemoteResource,
  body: Record<string, unknown>
): void {
  if (!remote.id || remote.name !== body.name)
    throw new Error('log_archive_remote_identity_mismatch');
  if (kind === 'stream') {
    const fields = object(remote.schema).fields;
    const normalized = Array.isArray(fields)
      ? fields.map((field) => {
          const value = object(field);
          return { name: value.name, type: value.type, required: value.required === true };
        })
      : undefined;
    if (
      !sameJson(normalized, LOG_ARCHIVE_STREAM_SCHEMA.fields) ||
      object(remote.http).enabled !== false ||
      object(remote.worker_binding).enabled !== true
    )
      throw new Error('log_archive_stream_schema_or_ingress_mismatch');
  } else if (kind === 'sink') {
    const actual = object(remote.config),
      expected = object(body.config);
    if (
      remote.type !== 'r2_data_catalog' ||
      object(remote.format).type !== 'parquet' ||
      object(remote.format).compression !== 'zstd' ||
      ['bucket', 'namespace', 'table_name'].some((key) => actual[key] !== expected[key])
    )
      throw new Error('log_archive_sink_configuration_mismatch');
  } else if (kind === 'pipeline' && remote.sql !== body.sql)
    throw new Error('log_archive_pipeline_sql_mismatch');
}

async function provisionPipelineResource(
  options: LogArchiveProvisionOptions,
  identity: ProvisioningResourceIdentity,
  body: Record<string, unknown>
): Promise<{ id: string; name: string }> {
  identity = {
    ...identity,
    configurationDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
  };
  const endpoint = `pipelines/v1/${identity.kind}s`;
  const prior = options.checkpoints[`${identity.kind}:${identity.binding}`];
  if (
    prior &&
    (prior.name !== identity.name ||
      prior.kind !== identity.kind ||
      prior.configurationDigest !== identity.configurationDigest)
  )
    throw new Error('log_archive_checkpoint_identity_changed');
  if (prior?.state === 'identified' || prior?.state === 'created') {
    if (!prior.id) throw new Error('log_archive_checkpoint_id_missing');
    const remote = await options.api.request<RemoteResource>(
      `${endpoint}/${encodeURIComponent(prior.id)}`
    );
    assertRemoteMatches(identity.kind, remote, body);
    await options.checkpoint({ ...identity, id: remote.id, state: 'created' });
    return { id: remote.id, name: remote.name };
  }
  // A request-issued checkpoint without an ID cannot prove ownership, even if names match.
  if (prior?.state === 'create_issued')
    throw new Error('log_archive_ambiguous_create_requires_recovery');
  const existing = await options.api.request<RemoteResource[]>(
    `${endpoint}?name=${encodeURIComponent(identity.name)}&per_page=100`
  );
  if (!Array.isArray(existing) || existing.some((item) => item.name === identity.name))
    throw new Error('log_archive_resource_already_exists_without_ownership');
  await options.checkpoint({ ...identity, state: 'create_issued' });
  let created: RemoteResource;
  try {
    created = await options.api.request<RemoteResource>(endpoint, 'POST', body);
  } catch (error) {
    if (error instanceof LogArchiveApiError && [400, 401, 403, 404, 422].includes(error.status))
      await options.checkpoint({ ...identity, state: 'create_rejected' });
    throw error;
  }
  if (!created.id || created.name !== identity.name)
    throw new Error('log_archive_create_identity_invalid');
  await options.checkpoint({ ...identity, id: created.id, state: 'identified' });
  const remote = await options.api.request<RemoteResource>(
    `${endpoint}/${encodeURIComponent(created.id)}`
  );
  assertRemoteMatches(identity.kind, remote, body);
  await options.checkpoint({ ...identity, id: created.id, state: 'created' });
  return { id: created.id, name: created.name };
}

export async function preflightLogArchive(
  options: Pick<
    LogArchiveProvisionOptions,
    'archive' | 'api' | 'catalogReadToken' | 'catalogWriteToken' | 'catalogSinkToken'
  >
): Promise<void> {
  assertLogArchiveImplemented(options.archive);
  if (
    !options.catalogReadToken.trim() ||
    !options.catalogWriteToken.trim() ||
    options.catalogReadToken === options.catalogWriteToken
  )
    throw new Error('log_archive_distinct_catalog_credentials_required');
  if (options.archive.mode === 'pipeline') {
    if (
      !options.catalogSinkToken?.trim() ||
      options.catalogSinkToken === options.catalogReadToken ||
      options.catalogSinkToken === options.catalogWriteToken
    )
      throw new Error('log_archive_distinct_sink_credential_required');
    await options.api.requireWorkersPaid();
  }
  await options.api.verifyCatalogCredentials(
    options.catalogReadToken,
    options.catalogWriteToken,
    options.archive.mode === 'pipeline' ? options.catalogSinkToken : undefined
  );
}

async function configureOwnedTableMaintenance(
  options: LogArchiveProvisionOptions
): Promise<LogArchiveLock['maintenance']> {
  const archive = options.archive;
  const path = `basin-catalog/${encodeURIComponent(archive.bucketName)}/namespaces/${encodeURIComponent(archive.namespace)}/tables/${encodeURIComponent(archive.tableName)}/maintenance-configs`;
  const deadline = Date.now() + (options.readinessTimeoutMs ?? 5 * 60_000);
  let lastProgressAt: number | undefined;
  let before: { maintenance_config: Record<string, unknown> };
  while (true) {
    try {
      before = await options.api.request<{ maintenance_config: Record<string, unknown> }>(path);
      break;
    } catch (error) {
      if (!(error instanceof LogArchiveApiError) || error.status !== 404) throw error;
      if (Date.now() >= deadline)
        throw new Error('log_archive_table_initialization_pending_retry_setup');
      if (lastProgressAt === undefined || Date.now() - lastProgressAt >= 30_000) {
        options.onProgress?.('Waiting for the owned Iceberg table to initialize...');
        lastProgressAt = Date.now();
      }
      await (
        options.waitForReadiness ??
        ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
      )(Math.min(2500, deadline - Date.now()));
    }
  }
  const previous = object(before.maintenance_config.snapshot_expiration);
  const previousCompaction = object(before.maintenance_config.compaction);
  if (
    previous.state !== 'disabled' ||
    previous.next_eligible_at !== null ||
    previousCompaction.state !== 'enabled' ||
    previousCompaction.target_size_mb !== '64'
  )
    await options.api.request(path, 'POST', {
      compaction: { state: 'enabled', target_size_mb: '64' },
      snapshot_expiration: {
        state: 'disabled',
        max_snapshot_age: previous.max_snapshot_age ?? '30d',
        min_snapshots_to_keep: previous.min_snapshots_to_keep ?? 5,
      },
    });
  const after = await options.api.request<{ maintenance_config: Record<string, unknown> }>(path);
  const snapshot = object(after.maintenance_config.snapshot_expiration);
  if (snapshot.state !== 'disabled' || snapshot.next_eligible_at !== null)
    throw new Error('log_archive_provider_snapshot_expiration_not_disabled');
  const compaction = object(after.maintenance_config.compaction);
  if (compaction.state !== 'enabled' || compaction.target_size_mb !== '64')
    throw new Error('log_archive_provider_compaction_not_enabled');
  if (
    compaction.next_eligible_at !== undefined &&
    compaction.next_eligible_at !== null &&
    (typeof compaction.next_eligible_at !== 'string' ||
      !Number.isFinite(Date.parse(compaction.next_eligible_at)))
  )
    throw new Error('log_archive_provider_compaction_eligibility_invalid');
  // Public Basin APIs expose eligibility, not a reliable running-job inventory. This evidence
  // must not be confused with an activation probe proving no previously claimed executor runs.
  return {
    policyDigest: LOG_ARCHIVE_MAINTENANCE_POLICY_DIGEST,
    snapshotExpirationState: 'disabled',
    compactionState: 'enabled',
    compactionTargetSizeMb: 64,
    ...(compaction.next_eligible_at !== undefined
      ? { compactionNextEligibleAt: compaction.next_eligible_at as string | null }
      : {}),
    nextEligibleAt: null,
    inFlightJobs: 'unverified',
  };
}

async function probeOwnedEmptyTable(
  options: LogArchiveProvisionOptions
): Promise<LogArchiveLock['activation']> {
  const loaded = await options.loadArchiveTable();
  const profile = inspectLogArchiveTable(loaded.metadata, options.archive.mode);
  assertLogArchiveTableLocations(loaded, options.archive.bucketName);
  const metadata = profile.metadata;
  if (
    (metadata['current-snapshot-id'] !== undefined &&
      metadata['current-snapshot-id'] !== null &&
      metadata['current-snapshot-id'] !== -1n &&
      String(metadata['current-snapshot-id']) !== '-1') ||
    (metadata.snapshots?.length ?? 0) !== 0
  ) {
    throw new Error('log_archive_initial_table_not_empty');
  }
  if (!loaded.metadataLocation) throw new Error('log_archive_metadata_location_missing');
  return {
    basis: 'new_owned_empty_table',
    tableUuid: metadata['table-uuid'],
    schemaId: metadata['current-schema-id'],
    specId: metadata['default-spec-id'],
    schemaSpecFingerprint: await logArchivePhysicalFingerprint(metadata),
    metadataLocation: loaded.metadataLocation,
    checkedAt: new Date().toISOString(),
  };
}

export async function provisionLogArchive(
  options: LogArchiveProvisionOptions
): Promise<LogArchiveLock> {
  await preflightLogArchive(options);
  await options.assertBucketOwned();
  const plan = planLogArchive(options.environment, options.archive);
  const identity = plan.resources.find((resource) => resource.kind === 'catalog')!;
  const path = `basin-catalog/${encodeURIComponent(options.archive.bucketName)}`;
  const prior = options.checkpoints['catalog:LOG_ARCHIVE_CATALOG'];
  let catalog: RemoteResource | undefined;
  try {
    catalog = await options.api.request<RemoteResource>(path);
  } catch (error) {
    if (!(error instanceof LogArchiveApiError) || error.status !== 404) throw error;
  }
  if (catalog) {
    if (
      !prior?.id ||
      !['identified', 'created'].includes(prior.state) ||
      prior.name !== identity.name ||
      prior.id !== catalog.id ||
      catalog.status !== 'active'
    )
      throw new Error('log_archive_catalog_ownership_unproven');
  } else {
    if (prior?.state === 'create_issued')
      throw new Error('log_archive_ambiguous_catalog_enable_requires_recovery');
    if (prior?.id) throw new Error('log_archive_catalog_recorded_but_missing');
    await options.checkpoint({ ...identity, state: 'create_issued' });
    try {
      catalog = await options.api.request<RemoteResource>(`${path}/enable`, 'POST');
    } catch (error) {
      if (error instanceof LogArchiveApiError && [400, 401, 403, 404, 422].includes(error.status))
        await options.checkpoint({ ...identity, state: 'create_rejected' });
      throw error;
    }
    if (!catalog.id || catalog.name !== `${options.api.accountId}_${options.archive.bucketName}`)
      throw new Error('log_archive_catalog_response_invalid');
    await options.checkpoint({ ...identity, id: catalog.id, state: 'identified' });
  }
  const warehouse = `${options.api.accountId}_${options.archive.bucketName}`;
  if (catalog.name !== warehouse) throw new Error('log_archive_catalog_warehouse_mismatch');
  await options.checkpoint({ ...identity, id: catalog.id, state: 'created' });
  const catalogUri = `https://catalog.cloudflarestorage.com/${options.api.accountId}/${options.archive.bucketName}`;
  const base: Omit<LogArchiveLock, 'maintenance' | 'activation'> = {
    mode: options.archive.mode,
    storageGeneration: options.archive.storageGeneration,
    activatedAt: options.archive.activatedAt,
    schemaVersion: options.archive.schemaVersion,
    schemaDigest: plan.schemaDigest,
    accountId: options.api.accountId,
    bucketName: options.archive.bucketName,
    namespace: options.archive.namespace,
    tableName: options.archive.tableName,
    catalogUri,
    warehouse,
    catalog: { id: catalog.id, name: catalog.name },
  };
  if (options.archive.mode === 'scheduled') {
    await options.prepareScheduledTable({ catalogUri, warehouse });
    const maintenance = await configureOwnedTableMaintenance(options);
    return { ...base, maintenance, activation: await probeOwnedEmptyTable(options) };
  }
  const stream = await provisionPipelineResource(
    options,
    plan.resources.find((resource) => resource.kind === 'stream')!,
    plan.streamBody!
  );
  const sinkBody = {
    ...plan.sinkBody,
    config: {
      ...object(plan.sinkBody!.config),
      account_id: options.api.accountId,
      token: options.catalogSinkToken,
    },
  };
  const sink = await provisionPipelineResource(
    options,
    plan.resources.find((resource) => resource.kind === 'sink')!,
    sinkBody
  );
  const pipeline = await provisionPipelineResource(
    options,
    plan.resources.find((resource) => resource.kind === 'pipeline')!,
    plan.pipelineBody!
  );
  const maintenance = await configureOwnedTableMaintenance(options);
  return {
    ...base,
    maintenance,
    stream,
    sink,
    pipeline,
    activation: await probeOwnedEmptyTable(options),
  };
}

/** Read-only preflight returns an explicit-deletion action, never a settings-update cleanup. */
export async function prepareLogArchiveDeletion(
  lock: LogArchiveLock,
  api: LogArchiveApi
): Promise<() => Promise<void>> {
  if (api.accountId !== lock.accountId) throw new Error('log_archive_deletion_account_mismatch');
  const targets = [
    { kind: 'pipeline', resource: lock.pipeline },
    { kind: 'sink', resource: lock.sink },
    { kind: 'stream', resource: lock.stream },
  ];
  const lookup = async (path: string): Promise<RemoteResource | undefined> => {
    try {
      return await api.request<RemoteResource>(path);
    } catch (error) {
      if (error instanceof LogArchiveApiError && error.status === 404) return undefined;
      throw error;
    }
  };
  const assertResource = async (
    path: string,
    resource: { id: string; name: string }
  ): Promise<RemoteResource | undefined> => {
    const remote = await lookup(path);
    if (remote && (remote.id !== resource.id || remote.name !== resource.name))
      throw new Error('log_archive_deletion_ownership_mismatch');
    return remote;
  };
  for (const target of targets)
    if (target.resource)
      await assertResource(
        `pipelines/v1/${target.kind}s/${encodeURIComponent(target.resource.id)}`,
        target.resource
      );
  const catalogPath = `basin-catalog/${encodeURIComponent(lock.bucketName)}`;
  await assertResource(catalogPath, lock.catalog);
  return async () => {
    for (const target of targets) {
      if (!target.resource) continue;
      const path = `pipelines/v1/${target.kind}s/${encodeURIComponent(target.resource.id)}`;
      if (await assertResource(path, target.resource)) {
        await api.request(path, 'DELETE');
        if (await lookup(path)) throw new Error('log_archive_deletion_visibility_unconfirmed');
      }
    }
    const catalog = await assertResource(catalogPath, lock.catalog);
    if (catalog) {
      if (catalog.status === 'active') await api.request(`${catalogPath}/disable`, 'POST');
      await api.request(`${catalogPath}/delete?force=true`, 'POST');
      if (await lookup(catalogPath))
        throw new Error('log_archive_catalog_deletion_visibility_unconfirmed');
    }
  };
}
