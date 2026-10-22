import {
  buildContractKey,
  deleteTenantExistsCache,
  requireDedicatedAdminDatabaseAdapter,
  type DatabaseAdapter,
  type Env,
} from '@authrim/ar-lib-core';
import { plannedInstalledSqliteDatasetSources } from '@authrim/ar-lib-core/services/tenant-portability/installed-sqlite-datasets';
import type { TenantBackupStepContext } from '@authrim/ar-lib-core/services/tenant-portability/operation-executor';
import { createPhase8SqliteInspectionPolicies } from '@authrim/ar-lib-core/services/tenant-portability/phase8-sqlite-references';
import {
  hasTenantDiscardRemaining,
  planTenantDiscard,
  runTenantDiscardPage,
  type TenantDiscardPlan,
} from '@authrim/ar-lib-core/services/tenant-portability/restore-target-discard';
import type { TenantBackupRestoreCleanupTarget } from '@authrim/ar-lib-core/services/tenant-portability/restore-target-cleanup';
import { decodeSqliteRestoreSequenceJobs } from '@authrim/ar-lib-core/services/tenant-portability/restore-sqlite-sequence';
import { invalidateSqliteRestoreTarget } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-restore-target';
import { readBackupSqliteSchemaDefinitions } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-schema-reader';
import type { BackupSchemaTable } from '@authrim/ar-lib-core/services/tenant-portability/sqlite-schema-types';
import {
  planPhase8InstalledSqliteResources,
  resolvePhase8SqlitePlanResources,
  type Phase8SqlitePlanResource,
} from './tenant-backup-phase8-plan-loader';

/**
 * Longest lease a restore worker can still act on after the cancellation (180 s), plus margin
 * for clock skew. Cleanup decides only after it, so no earlier restore lease opens a target late.
 */
export const TENANT_BACKUP_IMPORT_DISCARD_LEASE_WAIT_MS = 210_000;
/**
 * Longest scheduled run (15 min) plus the time a KV listing can take to show a new key (about a
 * minute). A settings projection that read a document before the discard deleted it may write
 * its key until the run ends; the final sweep lists the tenant's keys only after both.
 */
export const TENANT_BACKUP_IMPORT_DISCARD_PROJECTION_WAIT_MS = 17 * 60_000;

type Database = Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'>;
type BlockerKind = 'legal_hold' | 'blocked_rows' | 'schema_changed';

interface DiscardRow {
  first_seen_at: number;
  decision: 'none' | 'discard' | null;
  schema_digests_json: string | null;
  settings_deleted_at: number | null;
  kv_sweep_json: string | null;
  blocker_kind: BlockerKind | null;
  blocker_json: string | null;
}

interface RecordedTarget {
  targetId: string;
  resourceId: string;
  seedFingerprint: string;
}

interface Resource extends Phase8SqlitePlanResource {
  database: Database & Phase8SqlitePlanResource['database'];
  plan: TenantDiscardPlan;
  schema: readonly BackupSchemaTable[];
  /** Digest of the schema definitions every planned table was checked against. */
  planDigest: string;
}

/** Stable failure codes; the detail stays in the discard record and the operation view. */
export const TENANT_BACKUP_IMPORT_DISCARD_ERRORS: Readonly<Record<BlockerKind, string>> = {
  legal_hold: 'backup_import_cleanup_legal_hold',
  blocked_rows: 'backup_import_cleanup_blocked',
  schema_changed: 'backup_import_cleanup_schema_changed',
};

/** Tables readBackupSqliteDatabaseSchema leaves out: capture scratch and provider metadata. */
const SCHEMA_READER_SKIPPED_TABLES = [
  'tenant_backup_snapshots',
  'tenant_backup_preimages',
  '_cf_METADATA',
  '_cf_KV',
];

/** KV keys listed and deleted per call, well within one invocation's KV operations. */
const KV_KEYS_PER_PAGE = 100;
const KV_LIST_PAGES_PER_CALL = 10;

const LEASE = `EXISTS (SELECT 1 FROM tenant_backup_operations WHERE id=? AND tenant_id=?
  AND kind='import' AND state='cancelling' AND lease_owner=? AND fencing_token=?
  AND lease_expires_at>? AND updated_at<=?)`;

const unsupported = async (): Promise<never> => {
  throw new Error('backup_import_discard_policy_callback');
};

interface KvSweep {
  cursor: string | null;
  /** Keys deleted since this pass started at the first page. */
  deleted: number;
  /** One complete pass, from the first page to `list_complete`, deleted nothing. */
  clean: boolean;
}

/**
 * Continue the sweep of one prefix for a bounded number of pages. A listing may return empty pages
 * that are not the last ones (deleted keys still occupy them), so the cursor carries over between
 * calls and only a complete pass that deleted nothing marks the prefix clean.
 */
async function sweepKvPrefix(
  kv: KVNamespace | undefined,
  prefix: string,
  state: KvSweep
): Promise<KvSweep> {
  if (!kv || state.clean) return { cursor: null, deleted: 0, clean: true };
  let { cursor, deleted } = state;
  let deletedNow = 0;
  for (let page = 0; page < KV_LIST_PAGES_PER_CALL; page++) {
    const listed = await kv.list({ prefix, cursor: cursor ?? undefined, limit: KV_KEYS_PER_PAGE });
    await Promise.all(listed.keys.map((key) => kv.delete(key.name)));
    deleted += listed.keys.length;
    deletedNow += listed.keys.length;
    if (listed.list_complete)
      return deleted === 0
        ? { cursor: null, deleted: 0, clean: true }
        : { cursor: null, deleted: 0, clean: false };
    cursor = listed.cursor;
    if (deletedNow >= KV_KEYS_PER_PAGE) break;
  }
  return { cursor, deleted, clean: false };
}

/**
 * Discard the tenant of an import cancelled or failed for good while its SQL restore was writing.
 * Every deletion is chosen by trusted ownership; audit and log rows stay; the tenant row stays
 * and is marked deleted. The decision, its blockers and its timing are durable so any later
 * cleanup lease resumes them.
 */
export function createTenantBackupImportDiscard(input: {
  env: Env;
  tenantKey: string;
  platform: Database;
  resolveCoreDefault(context: TenantBackupStepContext): Promise<Database>;
  now: () => number;
  /** Test seam for the planner's resource inventory. */
  resolveResources?: (
    context: TenantBackupStepContext
  ) => Promise<readonly Phase8SqlitePlanResource[]>;
}) {
  const { env, now } = input;
  let adminDatabase: Database | undefined;
  // Resolved on first use: building the adapter must not require Admin until cleanup runs.
  const admin: Database = {
    query: (...args) =>
      (adminDatabase ??= requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup')).query(...args),
    queryOne: (...args) =>
      (adminDatabase ??= requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup')).queryOne(
        ...args
      ),
    execute: (...args) =>
      (adminDatabase ??= requireDedicatedAdminDatabaseAdapter(env, 'tenant-backup')).execute(
        ...args
      ),
  };
  const clock = () => {
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0)
      throw new Error('backup_import_discard_clock');
    return timestamp;
  };
  const leaseParams = (context: TenantBackupStepContext, timestamp: number) => [
    context.lease.operationId,
    context.lease.tenantId,
    context.lease.owner,
    context.lease.fencingToken,
    timestamp,
    timestamp,
  ];
  const authorize = async (context: TenantBackupStepContext) => {
    context.signal.throwIfAborted();
    if (!(await admin.queryOne(`SELECT 1 AS live WHERE ${LEASE}`, leaseParams(context, clock()))))
      throw new Error('backup_import_discard_fenced');
  };
  const load = (context: TenantBackupStepContext) =>
    admin.queryOne<DiscardRow>(
      `SELECT first_seen_at,decision,schema_digests_json,settings_deleted_at,kv_sweep_json,
      blocker_kind,blocker_json
      FROM tenant_backup_import_discards WHERE operation_id=? AND tenant_id=?`,
      [context.lease.operationId, context.lease.tenantId]
    );
  /** Writes of the discard record carry the cleanup lease in the same statement. */
  const update = async (
    context: TenantBackupStepContext,
    assignments: string,
    params: unknown[],
    condition = '1'
  ) => {
    const timestamp = clock();
    const result = await admin.execute(
      `UPDATE tenant_backup_import_discards SET ${assignments},updated_at=?
      WHERE operation_id=? AND tenant_id=? AND ${condition} AND ${LEASE}`,
      [
        ...params,
        timestamp,
        context.lease.operationId,
        context.lease.tenantId,
        ...leaseParams(context, timestamp),
      ]
    );
    if (!result.success) throw new Error('backup_import_discard_fenced');
  };
  const block = async (
    context: TenantBackupStepContext,
    kind: BlockerKind,
    detail: Record<string, unknown>
  ): Promise<never> => {
    await update(context, 'blocker_kind=?,blocker_json=?', [kind, JSON.stringify(detail)]);
    throw new Error(TENANT_BACKUP_IMPORT_DISCARD_ERRORS[kind]);
  };

  let resources:
    | { key: string; value: Promise<{ list: Resource[]; legalHoldsInBundle: number }> }
    | undefined;
  /** One schema read per cleanup lease, like the restore's own installed plan. */
  const loadResources = (context: TenantBackupStepContext) => {
    const key = `${context.lease.operationId}:${context.lease.owner}:${context.lease.fencingToken}`;
    if (resources?.key === key) return resources.value;
    const value = (async () => {
      await authorize(context);
      const planned = (
        input.resolveResources
          ? await input.resolveResources(context)
          : await resolvePhase8SqlitePlanResources(env, context.lease.tenantId, context.signal)
      ).map((resource) => ({ ...resource, database: resource.database as Resource['database'] }));
      const schemas = new Map<string, readonly BackupSchemaTable[]>();
      const datasets = await planPhase8InstalledSqliteResources(
        planned,
        context.signal,
        (resourceId, tables) => schemas.set(resourceId, tables)
      );
      // Each table's foreign keys were read in the same statement as its CREATE TABLE text. The
      // plan describes one schema only when every such text equals the definitions read now, which
      // destructive statements later pin; a change and revert during planning cannot pass this.
      const pinned = await Promise.all(
        planned.map(async (resource) => {
          const current = await readBackupSqliteSchemaDefinitions(
            resource.database,
            context.signal
          );
          const tablesSql = new Map(
            (
              JSON.parse(current.definitions) as {
                name: string;
                type: string;
                sql: string | null;
              }[]
            )
              .filter(({ type }) => type === 'table')
              .map(({ name, sql }) => [name, sql])
          );
          // The same tables (the reader skips only capture scratch and provider metadata), each
          // with the same CREATE TABLE text: a table hidden while the list was read cannot pass.
          const read = schemas.get(resource.resourceId) ?? [];
          for (const name of SCHEMA_READER_SKIPPED_TABLES) tablesSql.delete(name);
          if (read.length !== tablesSql.size)
            throw new Error('backup_import_discard_schema_moving');
          for (const table of read)
            if (!tablesSql.has(table.name) || tablesSql.get(table.name) !== table.sql)
              throw new Error('backup_import_discard_schema_moving');
          return current.digest;
        })
      );
      const policies = new Map(
        createPhase8SqliteInspectionPolicies(datasets, {
          tenantKey: input.tenantKey,
          validateAdminEnvelope: unsupported,
          validatePhase8Envelope: unsupported,
          // Discard planning reads ownership only; no row is inspected or restored here.
          resolveAdminReference: unsupported,
          resolvePluginReference: unsupported,
          restoreHold: { write: unsupported, verify: unsupported },
        }).map((policy) => [policy.dataset.id, policy])
      );
      const list = planned.map((resource, index): Resource => {
        const schema = schemas.get(resource.resourceId);
        if (!schema) throw new Error('backup_import_discard_plan_invalid');
        return {
          ...resource,
          schema,
          planDigest: pinned[index],
          plan: planTenantDiscard({
            family: resource.family,
            schema,
            identity: { tenantId: context.lease.tenantId, tenantKey: input.tenantKey },
            datasets: datasets
              .filter((entry) =>
                plannedInstalledSqliteDatasetSources(entry).some(
                  ({ resourceId }) => resourceId === resource.resourceId
                )
              )
              .map((entry) => {
                const policy = policies.get(entry.dataset.id);
                if (!policy) throw new Error('backup_import_discard_plan_invalid');
                return {
                  id: entry.dataset.id,
                  kind: entry.dataset.kind,
                  capture: entry.capture,
                  tenantKey: policy.restoreTenantKey,
                  referenceOnly: policy.restoreDisposition === 'reference_only',
                  deferredColumns: policy.deferredColumns ?? [],
                };
              }),
          }),
        };
      });
      return { list, legalHoldsInBundle: 0 };
    })();
    resources = { key, value };
    value.catch(() => {
      if (resources?.value === value) resources = undefined;
    });
    return value;
  };

  /** The sealed restore plan's targets and its legal-hold count, read under the cleanup lease. */
  const sealedPlan = async (context: TenantBackupStepContext) => {
    const timestamp = clock();
    const head = await admin.queryOne<{ chain_digest: string }>(
      `SELECT p.chain_digest FROM tenant_backup_restore_plan_inventories p
      WHERE p.operation_id=? AND p.tenant_id=? AND p.state='sealed' AND ${LEASE}`,
      [context.lease.operationId, context.lease.tenantId, ...leaseParams(context, timestamp)]
    );
    if (!head) return null;
    const items = await admin.query<{ item_id: string; payload_json: string }>(
      `SELECT item_id,payload_json FROM tenant_backup_restore_plan_inventory_items
      WHERE operation_id=? AND tenant_id=?
      AND (item_id LIKE 'restore-target:%' OR item_id='sqlite-restore-sequence') ORDER BY ordinal`,
      [context.lease.operationId, context.lease.tenantId]
    );
    const targets: RecordedTarget[] = [];
    let legalHolds = 0;
    for (const item of items) {
      const payload = JSON.parse(item.payload_json) as Record<string, unknown>;
      if (item.item_id === 'sqlite-restore-sequence') {
        for (const job of decodeSqliteRestoreSequenceJobs(item.payload_json))
          if (job.datasetId === 'core.legal_holds') legalHolds += job.recordCount;
        continue;
      }
      if (
        payload.kind !== 'sqlite-restore-target' ||
        typeof payload.targetId !== 'string' ||
        typeof payload.resourceId !== 'string' ||
        typeof payload.seedFingerprint !== 'string' ||
        item.item_id !== `restore-target:${payload.targetId}`
      )
        throw new Error('backup_import_discard_plan_invalid');
      targets.push({
        targetId: payload.targetId,
        resourceId: payload.resourceId,
        seedFingerprint: payload.seedFingerprint,
      });
    }
    return { digest: head.chain_digest, targets, legalHolds };
  };

  const lifecycle = async (context: TenantBackupStepContext) => {
    const query = 'SELECT lifecycle_state FROM tenants WHERE id=?';
    const [platform, core] = await Promise.all([
      input.platform.queryOne<{ lifecycle_state: string }>(query, [context.lease.tenantId]),
      input
        .resolveCoreDefault(context)
        .then((database) =>
          database.queryOne<{ lifecycle_state: string }>(query, [context.lease.tenantId])
        ),
    ]);
    return { platform: platform?.lifecycle_state ?? null, core: core?.lifecycle_state ?? null };
  };
  /** Never touch a tenant that left provisioning other than by this discard. */
  const assertUnpublished = async (context: TenantBackupStepContext, discarding: boolean) => {
    const states = await lifecycle(context);
    const allowed = discarding ? ['provisioning', 'deleted'] : ['provisioning'];
    if (
      !states.platform ||
      !allowed.includes(states.platform) ||
      (states.core !== null && !allowed.includes(states.core))
    )
      throw new Error('backup_import_discard_tenant_published');
    return states;
  };

  const assertBlocker = (row: DiscardRow) => {
    if (row.blocker_kind) throw new Error(TENANT_BACKUP_IMPORT_DISCARD_ERRORS[row.blocker_kind]);
  };

  /** Settle the decision once every earlier restore lease is over. Done once it is recorded. */
  const prepare = async (context: TenantBackupStepContext): Promise<{ done: boolean }> => {
    await authorize(context);
    const timestamp = clock();
    await admin.execute(
      `INSERT INTO tenant_backup_import_discards (operation_id,tenant_id,first_seen_at,updated_at)
      SELECT ?,?,?,? WHERE ${LEASE} ON CONFLICT(operation_id) DO NOTHING`,
      [
        context.lease.operationId,
        context.lease.tenantId,
        timestamp,
        timestamp,
        ...leaseParams(context, timestamp),
      ]
    );
    const row = await load(context);
    if (!row) throw new Error('backup_import_discard_fenced');
    if (row.decision) {
      // A legal hold never clears; other blockers are re-evaluated by the next discard page.
      if (row.blocker_kind === 'legal_hold') assertBlocker(row);
      return { done: true };
    }
    await assertUnpublished(context, false);
    if (timestamp < row.first_seen_at + TENANT_BACKUP_IMPORT_DISCARD_LEASE_WAIT_MS)
      return { done: false };
    const plan = await sealedPlan(context);
    // Whether anything was written needs only the databases, not a discard plan: a cancel
    // before any write never depends on the schemas being discardable.
    const databases = plan
      ? new Map(
          (input.resolveResources
            ? await input.resolveResources(context)
            : await resolvePhase8SqlitePlanResources(env, context.lease.tenantId, context.signal)
          ).map((resource) => [resource.resourceId, resource.database as Resource['database']])
        )
      : new Map<string, Resource['database']>();
    const written: RecordedTarget[] = [];
    for (const target of plan?.targets ?? []) {
      const database = databases.get(target.resourceId);
      if (!database) throw new Error('backup_import_discard_plan_invalid');
      if (
        await database.queryOne(
          'SELECT 1 AS found FROM tenant_backup_restore_targets WHERE operation_id=? AND tenant_id=? LIMIT 1',
          [context.lease.operationId, context.lease.tenantId]
        )
      )
        written.push(target);
    }
    if (!plan || !written.length) {
      await update(context, "decision='none',decided_at=?", [clock()], 'decision IS NULL');
      return { done: true };
    }
    const { list } = await loadResources(context);
    const byId = new Map(list.map((resource) => [resource.resourceId, resource]));
    // Fence every opened target before reading anything a stale writer could still change.
    const expiresAt = context.operation.lease_expires_at;
    if (!Number.isSafeInteger(expiresAt)) throw new Error('backup_import_discard_fenced');
    for (const target of written) {
      const resource = byId.get(target.resourceId);
      if (!resource) throw new Error('backup_import_discard_plan_invalid');
      await invalidateSqliteRestoreTarget({
        database: resource.database,
        identity: {
          id: target.targetId,
          tenantId: context.lease.tenantId,
          operationId: context.lease.operationId,
          resourceId: target.resourceId,
          planDigest: plan.digest,
          seedFingerprint: target.seedFingerprint,
        },
        lease: {
          owner: context.lease.owner,
          fencingToken: context.lease.fencingToken,
          expiresAt: expiresAt as number,
        },
        now: clock,
        authorize: () => authorize(context),
      });
    }
    // The schema every destructive statement must still find (see runTenantDiscardPage).
    const digests: Record<string, string> = {};
    for (const resource of list) {
      const current = await readBackupSqliteSchemaDefinitions(resource.database, context.signal);
      if (current.digest !== resource.planDigest)
        throw new Error('backup_import_discard_schema_moving');
      digests[resource.resourceId] = resource.planDigest;
    }
    const holds: string[] = [];
    let holdCount = 0;
    for (const resource of list) {
      if (!resource.schema.some(({ name }) => name === 'legal_holds')) continue;
      const rows = await resource.database.query<{ id: string }>(
        'SELECT id FROM legal_holds WHERE tenant_id=? ORDER BY id LIMIT 5',
        [context.lease.tenantId]
      );
      const count = await resource.database.queryOne<{ total: number }>(
        'SELECT count(*) AS total FROM legal_holds WHERE tenant_id=?',
        [context.lease.tenantId]
      );
      holds.push(...rows.map(({ id }) => id));
      holdCount += Number(count?.total ?? 0);
    }
    // Holds in the bundle that were not restored yet: their keys are still in the validation
    // index, which cleanup removes only after this decision.
    const bundleHoldIds: string[] = [];
    if (plan.legalHolds)
      for (const { record_id } of await admin.query<{ record_id: string }>(
        `SELECT DISTINCT r.record_id FROM tenant_backup_validation_records r
        JOIN tenant_backup_input_validations v ON v.session_id=r.session_id AND v.tenant_id=r.tenant_id
        WHERE v.operation_id=? AND v.tenant_id=? AND r.collection='core.legal_holds'
        ORDER BY r.record_id LIMIT 5`,
        [context.lease.operationId, context.lease.tenantId]
      )) {
        const key = JSON.parse(record_id) as unknown;
        const id = Array.isArray(key) && Array.isArray(key[0]) ? key[0][1] : null;
        if (typeof id === 'string') bundleHoldIds.push(id);
      }
    // The decision and a legal-hold stop are one write, so no interruption can drop the stop.
    const legalHold =
      holdCount || plan.legalHolds
        ? JSON.stringify({
            holdIds: holds.slice(0, 5),
            restoredHolds: holdCount,
            bundleHoldIds,
            bundleHolds: plan.legalHolds,
          })
        : null;
    await update(
      context,
      "decision='discard',decided_at=?,schema_digests_json=?,blocker_kind=?,blocker_json=?",
      [clock(), JSON.stringify(digests), legalHold ? 'legal_hold' : null, legalHold],
      'decision IS NULL'
    );
    if (legalHold) throw new Error(TENANT_BACKUP_IMPORT_DISCARD_ERRORS.legal_hold);
    return { done: true };
  };

  /** The recorded decision, preparing it first; null until it is settled. */
  const decided = async (context: TenantBackupStepContext) => {
    let row = await load(context);
    if (!row?.decision) {
      if (!(await prepare(context)).done) return null;
      row = await load(context);
      if (!row?.decision) throw new Error('backup_import_discard_fenced');
    }
    if (row.blocker_kind === 'legal_hold') assertBlocker(row);
    return row;
  };

  /** The schema recorded with the decision, which must still hold; its definitions for writes. */
  const assertSchema = async (
    context: TenantBackupStepContext,
    row: DiscardRow,
    resource: Resource
  ): Promise<string> => {
    const recorded = (JSON.parse(row.schema_digests_json ?? '{}') as Record<string, unknown>)[
      resource.resourceId
    ];
    const current = await readBackupSqliteSchemaDefinitions(resource.database, context.signal);
    // The plan, the decision and the database must all describe the same schema.
    if (
      typeof recorded === 'string' &&
      recorded === current.digest &&
      recorded === resource.planDigest
    )
      return current.definitions;
    return block(context, 'schema_changed', { resourceId: resource.resourceId });
  };
  /** Clear a blocker the data no longer shows (a legal hold never clears). */
  const clearRecoverable = async (context: TenantBackupStepContext, row: DiscardRow) => {
    if (row.blocker_kind === 'blocked_rows' || row.blocker_kind === 'schema_changed')
      await update(
        context,
        'blocker_kind=NULL,blocker_json=NULL',
        [],
        "blocker_kind IN ('blocked_rows','schema_changed')"
      );
  };

  /** One bounded slice of one database; true once none of the tenant's deletable rows remain. */
  const discardPage = async (
    context: TenantBackupStepContext,
    row: DiscardRow,
    resource: Resource
  ): Promise<boolean> => {
    const definitions = await assertSchema(context, row, resource);
    const result = await runTenantDiscardPage({
      database: resource.database,
      plan: resource.plan,
      authorize: () => authorize(context),
      signal: context.signal,
      schemaDefinitions: definitions,
    });
    await assertSchema(context, row, resource);
    if ('blocked' in result)
      await block(context, 'blocked_rows', {
        resourceId: resource.resourceId,
        table: result.blocked.table,
        reason: result.blocked.reason,
      });
    await clearRecoverable(context, row);
    return result.done;
  };

  /** The KV copies the provisioning cleanup removes outside the settings prefixes. */
  const deleteConfigKv = async (tenantId: string) => {
    await Promise.all([
      env.AUTHRIM_CONFIG?.delete(buildContractKey(env, 'tenant', tenantId)),
      env.AUTHRIM_CONFIG?.delete(`settings:tenant:${tenantId}:tenant`),
      env.AUTHRIM_CONFIG?.delete(`settings:tenant:${tenantId}:email-settings`),
      deleteTenantExistsCache(env.AUTHRIM_CONFIG, tenantId),
    ]);
  };
  const kvPrefixes = (tenantId: string) => [
    `settings:tenant:${tenantId}:`,
    `settings:client:${tenantId}:`,
  ];
  const kvSweeps = (row: DiscardRow, tenantId: string) => {
    const saved = JSON.parse(row.kv_sweep_json ?? '{}') as Record<string, KvSweep | undefined>;
    return kvPrefixes(tenantId).map(
      (prefix) => [prefix, saved[prefix] ?? { cursor: null, deleted: 0, clean: false }] as const
    );
  };
  /** One bounded step of the final settings sweep; true once every prefix had a clean pass. */
  const sweepSettingsKv = async (context: TenantBackupStepContext, row: DiscardRow) => {
    const next: Record<string, KvSweep> = {};
    for (const [prefix, state] of kvSweeps(row, context.lease.tenantId))
      next[prefix] = await sweepKvPrefix(env.SETTINGS, prefix, state);
    await update(context, 'kv_sweep_json=?', [JSON.stringify(next)]);
    return Object.values(next).every(({ clean }) => clean);
  };

  const markDeleted = async (context: TenantBackupStepContext) => {
    await authorize(context);
    const sql =
      "UPDATE tenants SET lifecycle_state='deleted', updated_at=? WHERE id=? AND lifecycle_state IN ('provisioning','deleted')";
    const seconds = Math.floor(clock() / 1000);
    await input.platform.execute(sql, [seconds, context.lease.tenantId]);
    await (await input.resolveCoreDefault(context)).execute(sql, [seconds, context.lease.tenantId]);
    const states = await lifecycle(context);
    if (states.platform !== 'deleted' || (states.core !== null && states.core !== 'deleted'))
      throw new Error('backup_import_discard_tenant_published');
  };

  return {
    prepare,

    /** Staging: one page of one planned restore target. */
    async cleanupTarget(
      context: TenantBackupStepContext,
      target: Readonly<TenantBackupRestoreCleanupTarget>
    ): Promise<{ done: boolean }> {
      const row = await decided(context);
      if (!row) return { done: false };
      if (row.decision === 'none') return { done: true };
      await assertUnpublished(context, true);
      const resource = (await loadResources(context)).list.find(
        ({ resourceId }) => resourceId === target.resourceId
      );
      if (!resource) throw new Error('backup_import_discard_plan_invalid');
      return { done: await discardPage(context, row, resource) };
    },

    /** Every database of the tenant, then the tenant state and its KV copies. */
    async cleanupAdditional(context: TenantBackupStepContext): Promise<{ done: boolean }> {
      const row = await decided(context);
      if (!row) return { done: false };
      if (row.decision === 'none') return { done: true };
      const timestamp = clock();
      if (
        row.settings_deleted_at !== null &&
        timestamp < row.settings_deleted_at + TENANT_BACKUP_IMPORT_DISCARD_PROJECTION_WAIT_MS
      )
        return { done: false };
      await assertUnpublished(context, true);
      const { list } = await loadResources(context);
      for (const resource of list)
        if (await hasTenantDiscardRemaining(resource.database, resource.plan))
          if (!(await discardPage(context, row, resource))) return { done: false };
      // Nothing is left to delete; a blocker recorded earlier no longer describes the data.
      if (row.blocker_kind) {
        for (const resource of list) await assertSchema(context, row, resource);
        await clearRecoverable(context, row);
      }
      if (row.settings_deleted_at === null) {
        await update(context, 'settings_deleted_at=?', [timestamp], 'settings_deleted_at IS NULL');
        await markDeleted(context);
        await deleteConfigKv(context.lease.tenantId);
        return { done: false };
      }
      await markDeleted(context);
      await deleteConfigKv(context.lease.tenantId);
      // Bounded per call; done once a complete listing of each prefix found nothing left.
      return { done: await sweepSettingsKv(context, row) };
    },

    /** Recheck everything the discard owns before the operation may finish. */
    async assertClean(context: TenantBackupStepContext): Promise<void> {
      const row = await load(context);
      if (!row?.decision) throw new Error('backup_import_discard_incomplete');
      if (row.decision === 'none') return;
      assertBlocker(row);
      if (
        row.settings_deleted_at === null ||
        clock() < row.settings_deleted_at + TENANT_BACKUP_IMPORT_DISCARD_PROJECTION_WAIT_MS
      )
        throw new Error('backup_import_discard_incomplete');
      const states = await lifecycle(context);
      if (states.platform !== 'deleted' || (states.core !== null && states.core !== 'deleted'))
        throw new Error('backup_import_discard_incomplete');
      for (const resource of (await loadResources(context)).list)
        if (await hasTenantDiscardRemaining(resource.database, resource.plan))
          throw new Error('backup_import_discard_incomplete');
      if (kvSweeps(row, context.lease.tenantId).some(([, state]) => !state.clean))
        throw new Error('backup_import_discard_incomplete');
    },
  };
}
