import { backupOwnershipPredicate, type BackupRowOwnership } from './row-ownership';
import { readSqliteRestoreSeedFingerprint } from './sqlite-restore-seed';
import type { DatabaseAdapter } from '../../db/adapter';
import type { TenantBundleManifest } from './bundle-manifest';
import {
  cloneSqliteDatasetInspectionPolicy,
  createSqliteDatasetInspectorFactory,
  type SqliteDatasetInspectionPolicy,
} from './sqlite-dataset-inspector';
import { sqliteSnapshotRowInsert } from './sqlite-row-codec';

type Database = Pick<DatabaseAdapter, 'query' | 'queryOne' | 'execute'> &
  Partial<Pick<DatabaseAdapter, 'batch'>>;
export type SqliteSidecarValue =
  | readonly ['null', null]
  | readonly ['text', string]
  | readonly ['integer', string];
export interface SqliteRestoreTargetIdentity {
  id: string;
  tenantId: string;
  operationId: string;
  resourceId: string;
  planDigest: string;
  seedFingerprint: string;
}
export interface SqliteRestoreTargetLease {
  owner: string;
  fencingToken: number;
  expiresAt: number;
}
const GUARD = `EXISTS (SELECT 1 FROM tenant_backup_restore_targets WHERE id=? AND tenant_id=?
  AND operation_id=? AND resource_id=? AND plan_digest=? AND seed_fingerprint=?
  AND owner=? AND fencing_token=? AND lease_expires_at>? AND state='loading')`;
const SEALED_GUARD = GUARD.replace("state='loading'", "state='sealed'");
const SEALABLE_GUARD = GUARD.replace("state='loading'", "state IN ('loading','sealed')");
export type SqliteRestoreTargetMode = 'write' | 'seal' | 'verify';
const error = () => new Error('backup_restore_target_rejected');
const APPEND_ONLY_OPERATIONAL_KINDS = new Set([
  'audit',
  'history',
  'sensitive_logs',
  'delivery_state',
  'log_dependencies',
]);

/**
 * R2 restore finalization rewrites these SQLite catalog fields and verifies every rewritten value
 * against the restored object receipt before targets are sealed. Final source-row readback therefore
 * compares the remaining SQLite-owned fields; write-time verification still compares every column.
 */
const R2_FINALIZED_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  ['admin', 'core'].flatMap((family) => [
    [`${family}.log_chunk_manifests`, ['status', 'manifest_object_key', 'checksum_sha256']],
    [
      `${family}.log_chunk_record_index`,
      ['line_number', 'block_offset', 'block_length', 'record_offset', 'record_length'],
    ],
    [
      `${family}.log_object_catalog`,
      [
        'object_key',
        'record_count',
        'byte_count',
        'checksum_sha256',
        'encryption_scope',
        'key_version',
      ],
    ],
    [
      `${family}.object_catalog_objects`,
      ['bucket_binding', 'object_key', 'key_version', 'checksum_sha256', 'total_bytes'],
    ],
    [
      `${family}.sensitive_detail_chunk_index`,
      [
        'object_key',
        'content_encoding',
        'line_number',
        'byte_offset',
        'byte_length',
        'key_version',
        'checksum_sha256',
        'deleted_at',
      ],
    ],
  ])
);
/** Fields asynchronously finalized by the unpublished target while its restore is still loading. */
const TARGET_RUNTIME_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'admin.tenant_settings_documents': ['projection_state', 'projected_at'],
};

/**
 * Fence a recorded unpublished target before provider cleanup. A missing local receipt means the
 * provisioned database was never opened; the coordinator must still delete that physical resource.
 */
export async function invalidateSqliteRestoreTarget(input: {
  database: Database;
  identity: SqliteRestoreTargetIdentity;
  lease: SqliteRestoreTargetLease;
  now: () => number;
  authorize: () => Promise<void>;
}): Promise<{ found: boolean }> {
  const identity = { ...input.identity };
  const lease = { ...input.lease };
  const current = input.now();
  if (
    Object.values(identity).some(
      (value) => typeof value !== 'string' || !value || value.length > 4096
    ) ||
    !/^[a-f0-9]{64}$/.test(identity.planDigest) ||
    !/^[a-f0-9]{64}$/.test(identity.seedFingerprint) ||
    !lease.owner ||
    !Number.isSafeInteger(lease.fencingToken) ||
    lease.fencingToken < 1 ||
    !Number.isSafeInteger(lease.expiresAt) ||
    !Number.isSafeInteger(current) ||
    current < 0 ||
    current >= lease.expiresAt
  )
    throw error();
  const params = [
    identity.id,
    identity.tenantId,
    identity.operationId,
    identity.resourceId,
    identity.planDigest,
    identity.seedFingerprint,
  ];
  await input.authorize();
  const existing = await input.database.queryOne<{ id: string }>(
    `SELECT id FROM tenant_backup_restore_targets WHERE id=? AND tenant_id=? AND operation_id=?
    AND resource_id=? AND plan_digest=? AND seed_fingerprint=?`,
    params
  );
  if (!existing) {
    await input.authorize();
    return { found: false };
  }
  await input.authorize();
  const result = await input.database.execute(
    `UPDATE tenant_backup_restore_targets SET owner=?,fencing_token=?,lease_expires_at=?,state='invalid'
    WHERE id=? AND tenant_id=? AND operation_id=? AND resource_id=? AND plan_digest=?
    AND seed_fingerprint=? AND state IN ('loading','sealed','invalid')
    AND (fencing_token<? OR (fencing_token=? AND owner=? AND lease_expires_at<=?))`,
    [
      lease.owner,
      lease.fencingToken,
      lease.expiresAt,
      ...params,
      lease.fencingToken,
      lease.fencingToken,
      lease.owner,
      lease.expiresAt,
    ]
  );
  if (!result.success || result.rowsAffected !== 1) throw error();
  if (
    !(await input.database.queryOne(
      `SELECT 1 AS invalid FROM tenant_backup_restore_targets WHERE id=? AND tenant_id=?
      AND operation_id=? AND resource_id=? AND plan_digest=? AND seed_fingerprint=?
      AND owner=? AND fencing_token=? AND lease_expires_at=? AND state='invalid'`,
      [...params, lease.owner, lease.fencingToken, lease.expiresAt]
    ))
  )
    throw error();
  await input.authorize();
  return { found: true };
}

/** An isolated staging database. Activation and the whole import plan remain coordinator-owned. */
export class SqliteRestoreTarget {
  private constructor(
    private readonly database: Database,
    private readonly identity: SqliteRestoreTargetIdentity,
    private readonly lease: SqliteRestoreTargetLease,
    private readonly now: () => number,
    /** Must verify the complete validated input plan, live import lease and unpublished routing. */
    private readonly authorize: () => Promise<void>,
    private readonly mode: SqliteRestoreTargetMode
  ) {}

  /**
   * Coordinator supplies an exclusive target admission guard and authoritative seed verification.
   * Reopening the same target does not reclassify partially imported rows as pre-existing data.
   */
  static async open(input: {
    database: Database;
    identity: SqliteRestoreTargetIdentity;
    lease: SqliteRestoreTargetLease;
    now: () => number;
    authorize: () => Promise<void>;
    readSeedFingerprint?: (assertAdmission: () => Promise<void>) => Promise<string>;
    mode?: SqliteRestoreTargetMode;
  }): Promise<SqliteRestoreTarget> {
    const mode = input.mode ?? 'write';
    if (!['write', 'seal', 'verify'].includes(mode)) throw error();
    const identity = { ...input.identity },
      lease = { ...input.lease };
    if (
      Object.values(identity).some((v) => typeof v !== 'string' || !v || v.length > 4096) ||
      !/^[a-f0-9]{64}$/.test(identity.planDigest) ||
      !/^[a-f0-9]{64}$/.test(identity.seedFingerprint) ||
      !lease.owner ||
      !Number.isSafeInteger(lease.fencingToken) ||
      lease.fencingToken < 1 ||
      !Number.isSafeInteger(lease.expiresAt)
    )
      throw error();
    const target = new SqliteRestoreTarget(
      input.database,
      identity,
      lease,
      input.now,
      input.authorize,
      mode
    );
    target.guard();
    await input.authorize();
    const existing = await input.database.queryOne<{ id: string }>(
      'SELECT id FROM tenant_backup_restore_targets LIMIT 1'
    );
    if (!existing) {
      if (mode !== 'write') throw error();
      const fingerprint = input.readSeedFingerprint
        ? await input.readSeedFingerprint(input.authorize)
        : await readSqliteRestoreSeedFingerprint(input.database, input.authorize);
      if (fingerprint !== identity.seedFingerprint) throw error();
      await input.authorize();
      target.guard();
      const result = await input.database.execute(
        `INSERT INTO tenant_backup_restore_targets
        (id,tenant_id,operation_id,resource_id,plan_digest,seed_fingerprint,owner,fencing_token,lease_expires_at,state)
        VALUES (?,?,?,?,?,?,?,?,?,'loading')`,
        [...target.identityParams(), lease.owner, lease.fencingToken, lease.expiresAt]
      );
      if (!result.success) throw error();
    } else {
      // Only the currently authorized coordinator can hand a target to a newer operation fence.
      const result = await input.database.execute(
        `UPDATE tenant_backup_restore_targets SET
        owner=?,fencing_token=?,lease_expires_at=? WHERE id=? AND tenant_id=? AND operation_id=?
        AND resource_id=? AND plan_digest=? AND seed_fingerprint=? AND ${mode === 'write' ? "state='loading'" : mode === 'verify' ? "state='sealed'" : "state IN ('loading','sealed')"}
        AND (fencing_token<? OR (fencing_token=? AND owner=? AND lease_expires_at<=?))`,
        [
          lease.owner,
          lease.fencingToken,
          lease.expiresAt,
          ...target.identityParams(),
          lease.fencingToken,
          lease.fencingToken,
          lease.owner,
          lease.expiresAt,
        ]
      );
      if (!result.success || result.rowsAffected !== 1) throw error();
    }
    await target.assertLive();
    return target;
  }
  private identityParams(): string[] {
    const i = this.identity;
    return [i.id, i.tenantId, i.operationId, i.resourceId, i.planDigest, i.seedFingerprint];
  }
  private guard(): unknown[] {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0 || now >= this.lease.expiresAt) throw error();
    return [...this.identityParams(), this.lease.owner, this.lease.fencingToken, now];
  }
  private guardSql(): string {
    return this.mode === 'write' ? GUARD : this.mode === 'verify' ? SEALED_GUARD : SEALABLE_GUARD;
  }
  private async assertLive(): Promise<void> {
    await this.authorize();
    if (!(await this.database.queryOne(`SELECT 1 AS live WHERE ${this.guardSql()}`, this.guard())))
      throw error();
  }
  /** No replacement/upsert: exact retries succeed, conflicting pre-existing rows stop the restore. */
  async writeRow(
    policy: SqliteDatasetInspectionPolicy,
    manifest: TenantBundleManifest,
    rowJson: string
  ): Promise<void> {
    if (this.mode !== 'write') throw error();
    await this.checkRow(policy, manifest, rowJson, true);
  }

  /**
   * Validate an installed-policy row batch in memory and commit it with one atomic D1 batch call.
   * Dataset verification is the durable readback boundary; no row checkpoint is written here.
   */
  async writeRows(
    policy: SqliteDatasetInspectionPolicy,
    manifest: TenantBundleManifest,
    rowJsons: readonly string[]
  ): Promise<void> {
    await this.writeDatasetRows([{ policy, manifest, rowJsons }]);
  }

  /**
   * Commit ordinary rows from multiple dependency-ordered tables in one D1 batch. The caller keeps
   * special transforms, holds, deferred references and reference-only datasets on their dedicated
   * paths; this method only combines the physical write without weakening row validation or fences.
   */
  async writeDatasetRows(
    datasets: readonly {
      policy: SqliteDatasetInspectionPolicy;
      manifest: TenantBundleManifest;
      rowJsons: readonly string[];
    }[]
  ): Promise<void> {
    const rowCount = datasets.reduce((total, dataset) => total + dataset.rowJsons.length, 0);
    const byteCount = datasets.reduce(
      (total, dataset) =>
        total +
        dataset.rowJsons.reduce(
          (datasetTotal, row) => datasetTotal + new TextEncoder().encode(row).length,
          0
        ),
      0
    );
    if (
      this.mode !== 'write' ||
      datasets.length < 1 ||
      datasets.length > 256 ||
      rowCount < 1 ||
      rowCount > 500 ||
      byteCount > 4 * 1024 * 1024
    )
      throw error();
    await this.assertLive();
    const statements = [];
    for (const dataset of datasets) {
      if (!dataset.rowJsons.length) throw error();
      for (const original of dataset.rowJsons) {
        const validated = await this.validateRow(dataset.policy, dataset.manifest, original, false);
        const currentPolicy = validated.policy;
        let storedRowJson = this.applyRestoreOverrides(currentPolicy, original);
        if (currentPolicy.deferredColumns?.length) {
          const row = JSON.parse(storedRowJson) as Record<string, unknown>;
          for (const column of currentPolicy.deferredColumns) row[column] = ['null', null];
          storedRowJson = JSON.stringify(row);
        }
        const insert = sqliteSnapshotRowInsert(
          currentPolicy.schema.table,
          currentPolicy.schema.columns,
          storedRowJson
        );
        const keyInsert = sqliteSnapshotRowInsert(
          currentPolicy.schema.table,
          currentPolicy.schema.primaryKey,
          JSON.stringify(
            Object.fromEntries(
              currentPolicy.schema.primaryKey.map((column) => [
                column,
                (JSON.parse(storedRowJson) as Record<string, unknown>)[column],
              ])
            )
          )
        );
        const expressions = keyInsert.sql
          .slice(keyInsert.sql.indexOf(' VALUES (') + 9, -1)
          .split(', ');
        const predicate = currentPolicy.schema.primaryKey
          .map((column, index) => `"${column}" IS ${expressions[index]}`)
          .join(' AND ');
        const insertSelect =
          insert.sql.replace(' VALUES (', ' SELECT ').slice(0, -1) + ` WHERE ${this.guardSql()}`;
        const preserved = new Set(currentPolicy.restorePreservedSeedColumns ?? []);
        const replaceSeed = currentPolicy.restoreReplacesInstalledSeedRows === true;
        const nonKeyColumns = currentPolicy.schema.columns.filter(
          (column) => !currentPolicy.schema.primaryKey.includes(column) && !preserved.has(column)
        );
        // A target-owned seed may preserve every non-key column. There is nothing to mutate in that
        // case; the dataset readback phase still requires the installed target row to exist.
        if (replaceSeed && !nonKeyColumns.length) continue;
        statements.push(
          replaceSeed
            ? {
                sql: `${insertSelect}${
                  preserved.size
                    ? ` AND EXISTS (SELECT 1 FROM "${currentPolicy.schema.table}" WHERE ${predicate})`
                    : ''
                } ON CONFLICT (${currentPolicy.schema.primaryKey
                  .map((column) => `"${column}"`)
                  .join(', ')}) DO UPDATE SET ${nonKeyColumns
                  .map((column) => `"${column}"=excluded."${column}"`)
                  .join(', ')}`,
                params: [
                  ...insert.params,
                  ...this.guard(),
                  ...(preserved.size ? keyInsert.params : []),
                ],
              }
            : {
                sql: `${insertSelect} AND NOT EXISTS (SELECT 1 FROM "${currentPolicy.schema.table}" WHERE ${predicate})`,
                params: [...insert.params, ...this.guard(), ...keyInsert.params],
              }
        );
      }
    }
    await this.authorize();
    const results = this.database.batch
      ? await this.database.batch(statements)
      : await Promise.all(statements.map(({ sql, params }) => this.database.execute(sql, params)));
    if (results.length !== statements.length || results.some(({ success }) => !success))
      throw error();
    await this.assertLive();
  }

  /**
   * Remove rows created as a restore side effect and atomically replace them with the validated
   * source set. Only explicitly installed hold policies may use this path.
   */
  async reconcileGeneratedRows(
    policy: SqliteDatasetInspectionPolicy,
    manifest: TenantBundleManifest,
    rowJsons: readonly string[]
  ): Promise<void> {
    if (
      this.mode !== 'write' ||
      policy.restoreReconcilesGeneratedRows !== true ||
      !policy.restoreHold ||
      policy.restoreDisposition === 'reference_only' ||
      policy.deferredColumns?.length ||
      policy.restoreTransform ||
      policy.restoreReplacesInstalledSeedRows ||
      rowJsons.length > 500 ||
      rowJsons.reduce((total, row) => total + new TextEncoder().encode(row).length, 0) >
        4 * 1024 * 1024 ||
      !this.database.batch
    )
      throw error();
    const pinned = cloneSqliteDatasetInspectionPolicy(policy);
    const direct = 'parent' in pinned.schema ? pinned.schema.parent.schema : pinned.schema;
    const tenantKey = pinned.restoreTenantKey ?? pinned.tenantKey;
    if (direct.tenantIdentity === 'tenantKey' && !tenantKey) throw error();
    const ownership = (schema: typeof pinned.schema): BackupRowOwnership => {
      if ('parent' in schema)
        return {
          kind: 'parent',
          table: schema.parent.schema.table,
          keys: schema.parent.schema.primaryKey.map((parent, index) => ({
            parent,
            child: schema.parent.childColumns[index],
          })),
          ownership: ownership(schema.parent.schema),
        };
      return schema.scopeTypeColumn
        ? { kind: 'scope', typeColumn: schema.scopeTypeColumn, idColumn: schema.tenantColumn }
        : {
            kind: 'tenant',
            column: schema.tenantColumn,
            identity: schema.tenantIdentity ?? 'tenantId',
          };
    };
    const predicate = backupOwnershipPredicate(
      ownership(pinned.schema),
      {
        tenantId: this.identity.tenantId,
        tenantKey: tenantKey ?? this.identity.tenantId,
      },
      'backup_row'
    );
    await this.assertLive();
    const statements: Array<{ sql: string; params: unknown[] }> = [
      {
        sql: `DELETE FROM "${pinned.schema.table}" AS "backup_row"
          WHERE ${predicate.sql} AND ${this.guardSql()}`,
        params: [...predicate.params, ...this.guard()],
      },
    ];
    for (const original of rowJsons) {
      const validated = await this.validateRow(pinned, manifest, original, false);
      const rowJson = this.applyRestoreOverrides(validated.policy, original);
      const insert = sqliteSnapshotRowInsert(
        validated.policy.schema.table,
        validated.policy.schema.columns,
        rowJson
      );
      statements.push({
        sql: insert.sql.replace(' VALUES (', ' SELECT ').slice(0, -1) + ` WHERE ${this.guardSql()}`,
        params: [...insert.params, ...this.guard()],
      });
    }
    const batch = this.database.batch;
    if (!batch) throw error();
    await this.authorize();
    const results = await batch.call(this.database, statements);
    if (results.length !== statements.length || results.some(({ success }) => !success))
      throw error();
    if (rowJsons.length) await this.verifyRows(pinned, manifest, rowJsons);
    await this.verifyDataset(pinned, rowJsons.length);
  }
  /** Readback only: missing or changed rows fail without repairing them during verification. */
  async verifyRow(
    policy: SqliteDatasetInspectionPolicy,
    manifest: TenantBundleManifest,
    rowJson: string
  ): Promise<void> {
    await this.checkRow(policy, manifest, rowJson, false);
  }

  /** Verify ordinary restored rows with bounded aggregate queries instead of one D1 call per row. */
  async verifyRows(
    policy: SqliteDatasetInspectionPolicy,
    manifest: TenantBundleManifest,
    rowJsons: readonly string[]
  ): Promise<void> {
    if (
      rowJsons.length < 1 ||
      rowJsons.length > 500 ||
      rowJsons.reduce((total, row) => total + new TextEncoder().encode(row).length, 0) >
        4 * 1024 * 1024
    )
      throw error();
    await this.assertLive();
    const pending: Array<{ sql: string; params: unknown[] }> = [];
    for (const original of rowJsons) {
      const validated = await this.validateRow(policy, manifest, original, false);
      const rowJson = this.applyRestoreOverrides(validated.policy, original);
      const clauses = this.rowMatchClauses(validated.policy, rowJson);
      // Very wide rows retain the existing bounded comparison path.
      if (clauses.length !== 1 || clauses[0].params.length > 80) {
        if (!(await this.rowMatches(validated.policy, rowJson))) throw error();
        continue;
      }
      pending.push(clauses[0]);
    }
    while (pending.length) {
      const group: typeof pending = [];
      let parameters = this.guard().length;
      while (pending.length && parameters + pending[0].params.length <= 90) {
        const clause = pending.shift();
        if (!clause) break;
        group.push(clause);
        parameters += clause.params.length;
      }
      if (!group.length) throw error();
      const found = await this.database.queryOne<{ matches: number | bigint }>(
        `SELECT COUNT(*) AS matches FROM "${policy.schema.table}" WHERE ${this.guardSql()}
        AND (${group.map(({ sql }) => `(${sql})`).join(' OR ')})`,
        [...this.guard(), ...group.flatMap(({ params }) => params)]
      );
      if (Number(found?.matches) !== group.length) throw error();
    }
    await this.assertLive();
  }
  /** Apply one installed sidecar value while this target is still fenced and unpublished. */
  async writeSidecarText(
    policy: SqliteDatasetInspectionPolicy,
    manifest: TenantBundleManifest,
    rowJson: string,
    column: string,
    targetValue: string,
    matches: (storedValue: string) => Promise<boolean>
  ): Promise<void> {
    if (this.mode !== 'write' || !targetValue) throw error();
    await this.sidecarTypedValue(
      policy,
      manifest,
      rowJson,
      column,
      ['text', targetValue],
      async (stored) => stored[0] === 'text' && stored[1] !== null && matches(stored[1]),
      true
    );
  }

  /** Apply a text or integer sidecar value from its exact installed restore placeholder. */
  async writeSidecarValue(
    policy: SqliteDatasetInspectionPolicy,
    manifest: TenantBundleManifest,
    rowJson: string,
    column: string,
    targetValue: Exclude<SqliteSidecarValue, readonly ['null', null]>,
    matches: (storedValue: SqliteSidecarValue) => Promise<boolean>
  ): Promise<void> {
    if (this.mode !== 'write') throw error();
    await this.sidecarTypedValue(policy, manifest, rowJson, column, targetValue, matches, true);
  }
  /** Verify a sidecar-owned value after the target has been sealed. */
  async verifySidecarValue(
    policy: SqliteDatasetInspectionPolicy,
    manifest: TenantBundleManifest,
    rowJson: string,
    column: string,
    matches: (storedValue: string | null) => Promise<boolean>
  ): Promise<void> {
    await this.sidecarTypedValue(
      policy,
      manifest,
      rowJson,
      column,
      null,
      async (stored) =>
        stored[0] === 'null'
          ? matches(null)
          : stored[0] === 'text' && stored[1] !== null
            ? matches(stored[1])
            : false,
      false
    );
  }

  /** Verify a sidecar-owned text or integer value after the target has been sealed. */
  async verifySidecarTypedValue(
    policy: SqliteDatasetInspectionPolicy,
    manifest: TenantBundleManifest,
    rowJson: string,
    column: string,
    matches: (storedValue: SqliteSidecarValue) => Promise<boolean>
  ): Promise<void> {
    await this.sidecarTypedValue(policy, manifest, rowJson, column, null, matches, false);
  }
  /** Complete nullable self references after every row in the same dataset exists. */
  async restoreDeferredRow(
    policy: SqliteDatasetInspectionPolicy,
    manifest: TenantBundleManifest,
    rowJson: string
  ): Promise<void> {
    if (this.mode !== 'write' || !policy.deferredColumns?.length) throw error();
    ({ policy, manifest } = await this.validateRow(policy, manifest, rowJson));
    const restoredRowJson = this.applyRestoreOverrides(policy, rowJson);
    const parsed = JSON.parse(restoredRowJson) as Record<string, unknown>;
    const deferred = policy.deferredColumns;
    if (!deferred?.length) throw error();
    if (await this.rowMatches(policy, restoredRowJson)) return;
    const values = sqliteSnapshotRowInsert(
      policy.schema.table,
      deferred,
      JSON.stringify(Object.fromEntries(deferred.map((column) => [column, parsed[column]])))
    );
    const expressions = values.sql.slice(values.sql.indexOf(' VALUES (') + 9, -1).split(', ');
    const key = sqliteSnapshotRowInsert(
      policy.schema.table,
      policy.schema.primaryKey,
      JSON.stringify(
        Object.fromEntries(policy.schema.primaryKey.map((column) => [column, parsed[column]]))
      )
    );
    const keyExpressions = key.sql.slice(key.sql.indexOf(' VALUES (') + 9, -1).split(', ');
    const assignments = deferred.map((column, index) => `"${column}"=${expressions[index]}`);
    const predicate = policy.schema.primaryKey
      .map((column, index) => `"${column}" IS ${keyExpressions[index]}`)
      .join(' AND ');
    await this.assertLive();
    const result = await this.database.execute(
      `UPDATE "${policy.schema.table}" SET ${assignments.join(', ')} WHERE ${this.guardSql()} AND ${predicate}`,
      [...values.params, ...this.guard(), ...key.params]
    );
    if (!result.success || result.rowsAffected !== 1) throw error();
    if (!(await this.rowMatches(policy, restoredRowJson))) throw error();
  }

  private applyRestoreOverrides(policy: SqliteDatasetInspectionPolicy, rowJson: string): string {
    if (!policy.restoreOverrides && !policy.restoreIdentityOverrides) return rowJson;
    const row = JSON.parse(rowJson) as Record<string, unknown>;
    for (const [column, value] of Object.entries(policy.restoreOverrides ?? {}))
      row[column] = value;
    for (const [column, value] of Object.entries(policy.restoreIdentityOverrides ?? {}))
      row[column] = value;
    return JSON.stringify(row);
  }

  private async sidecarTypedValue(
    policy: SqliteDatasetInspectionPolicy,
    manifest: TenantBundleManifest,
    rowJson: string,
    column: string,
    targetValue: SqliteSidecarValue | null,
    matches: (storedValue: SqliteSidecarValue) => Promise<boolean>,
    write: boolean
  ): Promise<void> {
    ({ policy, manifest } = await this.validateRow(policy, manifest, rowJson));
    const placeholder = policy.restoreOverrides?.[column];
    if (
      !/^[a-z][a-z0-9_]*$/.test(column) ||
      !policy.verificationIgnoredColumns?.includes(column) ||
      !placeholder ||
      !(['null', 'text', 'integer'] as const).includes(
        placeholder[0] as 'null' | 'text' | 'integer'
      ) ||
      (targetValue !== null && (targetValue[0] === 'null' || typeof targetValue[1] !== 'string'))
    )
      throw error();
    const row = JSON.parse(this.applyRestoreOverrides(policy, rowJson)) as Record<string, unknown>;
    const key = sqliteSnapshotRowInsert(
      policy.schema.table,
      policy.schema.primaryKey,
      JSON.stringify(
        Object.fromEntries(policy.schema.primaryKey.map((keyColumn) => [keyColumn, row[keyColumn]]))
      )
    );
    const keyExpressions = key.sql.slice(key.sql.indexOf(' VALUES (') + 9, -1).split(', ');
    const predicate = policy.schema.primaryKey
      .map((keyColumn, index) => `"${keyColumn}" IS ${keyExpressions[index]}`)
      .join(' AND ');
    const read = async () => {
      await this.assertLive();
      return this.database.queryOne<{ value_type: string; value: unknown }>(
        `SELECT typeof("${column}") AS value_type,
        CASE WHEN typeof("${column}")='integer' THEN CAST("${column}" AS TEXT)
             ELSE "${column}" END AS value
        FROM "${policy.schema.table}" WHERE ${this.guardSql()} AND ${predicate}`,
        [...this.guard(), ...key.params]
      );
    };
    const decodeStored = (current: { value_type: string; value: unknown }): SqliteSidecarValue => {
      if (current.value_type === 'null' && current.value === null) return ['null', null];
      if (current.value_type === 'text' && typeof current.value === 'string')
        return ['text', current.value];
      if (
        current.value_type === 'integer' &&
        typeof current.value === 'string' &&
        /^(0|-?[1-9][0-9]{0,18})$/.test(current.value)
      )
        return ['integer', current.value];
      throw error();
    };
    let current = await read();
    if (!current) throw error();
    const stored = decodeStored(current);
    if (await matches(stored)) return;
    if (!write || targetValue === null || JSON.stringify(stored) !== JSON.stringify(placeholder))
      throw error();
    const target = sqliteSnapshotRowInsert(
      policy.schema.table,
      [column],
      JSON.stringify({ [column]: targetValue })
    );
    const targetExpression = target.sql.slice(target.sql.indexOf(' VALUES (') + 9, -1);
    const expected = sqliteSnapshotRowInsert(
      policy.schema.table,
      [column],
      JSON.stringify({ [column]: placeholder })
    );
    const expectedExpression = expected.sql.slice(expected.sql.indexOf(' VALUES (') + 9, -1);
    await this.assertLive();
    const result = await this.database.execute(
      `UPDATE "${policy.schema.table}" SET "${column}"=${targetExpression}
      WHERE ${this.guardSql()} AND ${predicate}
      AND typeof("${column}")=? AND "${column}" IS ${expectedExpression}`,
      [...target.params, ...this.guard(), ...key.params, placeholder[0], ...expected.params]
    );
    if (!result.success) throw error();
    current = await read();
    if (!current || !(await matches(decodeStored(current)))) throw error();
  }

  private async validateRow(
    policy: SqliteDatasetInspectionPolicy,
    manifest: TenantBundleManifest,
    rowJson: string,
    assertLive = true
  ): Promise<{ policy: SqliteDatasetInspectionPolicy; manifest: TenantBundleManifest }> {
    policy = cloneSqliteDatasetInspectionPolicy(policy);
    manifest = structuredClone(manifest);
    if (
      manifest.source.tenantId !== this.identity.tenantId ||
      !manifest.datasets.some(
        (dataset) =>
          dataset.id === policy.dataset.id &&
          dataset.module === policy.dataset.module &&
          dataset.schemaVersion === policy.dataset.schemaVersion &&
          dataset.store === 'database' &&
          dataset.disposition === 'include'
      )
    )
      throw error();
    if (assertLive) await this.assertLive();
    const inspector = await createSqliteDatasetInspectorFactory(policy)(policy.dataset, manifest);
    try {
      const bytes = new TextEncoder().encode(rowJson + '\n');
      if (bytes.length > 256 * 1024) throw error();
      const inspected = await inspector.chunk(bytes, 0);
      if (!inspected.records.length) throw error();
      await inspector.finish();
    } finally {
      await inspector.dispose();
    }
    return { policy, manifest };
  }

  private async checkRow(
    policy: SqliteDatasetInspectionPolicy,
    manifest: TenantBundleManifest,
    rowJson: string,
    write: boolean
  ): Promise<void> {
    ({ policy, manifest } = await this.validateRow(policy, manifest, rowJson));
    let storedRowJson = this.applyRestoreOverrides(policy, rowJson);
    if (write && policy.deferredColumns?.length) {
      const row = JSON.parse(rowJson) as Record<string, unknown>;
      for (const column of policy.deferredColumns) row[column] = ['null', null];
      storedRowJson = JSON.stringify(row);
    }
    const insert = sqliteSnapshotRowInsert(
      policy.schema.table,
      policy.schema.columns,
      storedRowJson
    );
    const targetOwnedSeedColumns = new Set(policy.restorePreservedSeedColumns ?? []);
    if (write) {
      const keyInsert = sqliteSnapshotRowInsert(
        policy.schema.table,
        policy.schema.primaryKey,
        JSON.stringify(
          Object.fromEntries(
            policy.schema.primaryKey.map((column) => [
              column,
              (JSON.parse(storedRowJson) as Record<string, unknown>)[column],
            ])
          )
        )
      );
      const expressions = keyInsert.sql
        .slice(keyInsert.sql.indexOf(' VALUES (') + 9, -1)
        .split(', ');
      const predicate = policy.schema.primaryKey
        .map((column, i) => `"${column}" IS ${expressions[i]}`)
        .join(' AND ');
      const insertSelect =
        insert.sql.replace(' VALUES (', ' SELECT ').slice(0, -1) + ` WHERE ${this.guardSql()}`;
      const replaceSeed = policy.restoreReplacesInstalledSeedRows === true;
      const nonKeyColumns = policy.schema.columns.filter(
        (column) =>
          !policy.schema.primaryKey.includes(column) && !targetOwnedSeedColumns.has(column)
      );
      const sql =
        replaceSeed && !nonKeyColumns.length
          ? null
          : replaceSeed
            ? `${insertSelect}${
                targetOwnedSeedColumns.size
                  ? ` AND EXISTS (SELECT 1 FROM "${policy.schema.table}" WHERE ${predicate})`
                  : ''
              } ON CONFLICT (${policy.schema.primaryKey
                .map((column) => `"${column}"`)
                .join(', ')}) DO UPDATE SET ${nonKeyColumns
                .map((column) => `"${column}"=excluded."${column}"`)
                .join(', ')}`
            : `${insertSelect} AND NOT EXISTS (SELECT 1 FROM "${policy.schema.table}" WHERE ${predicate})`;
      if (sql) {
        await this.assertLive();
        const result = await this.database.execute(sql, [
          ...insert.params,
          ...this.guard(),
          ...(!replaceSeed || targetOwnedSeedColumns.size ? keyInsert.params : []),
        ]);
        if (!result.success) throw error();
      }
    }
    if (!(await this.rowMatches(policy, storedRowJson, targetOwnedSeedColumns))) throw error();
    await this.assertLive();
  }

  /** Compare stored values and storage types, including integer precision and blob bytes. */
  private async rowMatches(
    policy: SqliteDatasetInspectionPolicy,
    rowJson: string,
    additionalIgnoredColumns: ReadonlySet<string> = new Set()
  ): Promise<boolean> {
    for (const clause of this.rowMatchClauses(policy, rowJson, additionalIgnoredColumns)) {
      const match = await this.database.queryOne(
        `SELECT 1 AS matches FROM "${policy.schema.table}" WHERE ${clause.sql} AND ${this.guardSql()}`,
        [...clause.params, ...this.guard()]
      );
      if (!match) return false;
    }
    return true;
  }

  private rowMatchClauses(
    policy: SqliteDatasetInspectionPolicy,
    rowJson: string,
    additionalIgnoredColumns: ReadonlySet<string> = new Set()
  ): Array<{ sql: string; params: unknown[] }> {
    const insert = sqliteSnapshotRowInsert(policy.schema.table, policy.schema.columns, rowJson);
    const values = insert.sql.slice(insert.sql.indexOf(' VALUES (') + 9, -1).split(', ');
    const row = JSON.parse(rowJson) as Record<string, readonly [string, unknown]>;
    const ignored = new Set([
      ...(policy.verificationIgnoredColumns ?? []),
      ...additionalIgnoredColumns,
      ...(TARGET_RUNTIME_COLUMNS[policy.dataset.id] ?? []),
      ...(this.mode === 'verify' ? (R2_FINALIZED_COLUMNS[policy.dataset.id] ?? []) : []),
    ]);
    const parameterByColumn = new Map<string, unknown>();
    let position = 0;
    for (const [index, column] of policy.schema.columns.entries()) {
      const parameterized =
        !['Inf', '-Inf'].includes(String(row[column][1])) || row[column][0] !== 'real';
      const parameter = parameterized ? insert.params[position++] : undefined;
      if (parameterized) parameterByColumn.set(column, parameter);
      if (!values[index]) throw error();
    }
    const primaryKey = [...policy.schema.primaryKey];
    if (!primaryKey.length) throw error();
    const compared = policy.schema.columns.filter(
      (column) => !ignored.has(column) && !primaryKey.includes(column)
    );
    const chunks: string[][] = [];
    for (let index = 0; index < compared.length; index += 32)
      chunks.push(compared.slice(index, index + 32));
    if (!chunks.length) chunks.push([]);
    const columnClause = (column: string): { sql: string; params: unknown[] } => {
      const index = policy.schema.columns.indexOf(column);
      if (index < 0) throw error();
      const params: unknown[] = [row[column][0]];
      if (parameterByColumn.has(column)) params.push(parameterByColumn.get(column));
      return {
        sql: `typeof("${column}")=? AND "${column}" COLLATE BINARY IS ${values[index]}`,
        params,
      };
    };
    return chunks.map((chunk) => {
      const comparisons = [...primaryKey, ...chunk].map(columnClause);
      return {
        sql: comparisons.map(({ sql }) => sql).join(' AND '),
        params: comparisons.flatMap(({ params }) => params),
      };
    });
  }
  /** Verify the complete selected tenant dataset, after all of its expected rows were read back. */
  async verifyDataset(policy: SqliteDatasetInspectionPolicy, expectedRows: number): Promise<void> {
    const { schema, tenantKey } = structuredClone({
      schema: policy.schema,
      tenantKey: policy.restoreTenantKey ?? policy.tenantKey,
    });
    if (
      !Number.isSafeInteger(expectedRows) ||
      expectedRows < 0 ||
      !/^[a-z][a-z0-9_]*$/.test(schema.table)
    )
      throw error();
    function ownership(value: typeof schema): BackupRowOwnership {
      if ('parent' in value)
        return {
          kind: 'parent',
          table: value.parent.schema.table,
          keys: value.parent.schema.primaryKey.map((parent, i) => ({
            parent,
            child: value.parent.childColumns[i],
          })),
          ownership: ownership(value.parent.schema),
        };
      return value.scopeTypeColumn
        ? { kind: 'scope', typeColumn: value.scopeTypeColumn, idColumn: value.tenantColumn }
        : {
            kind: 'tenant',
            column: value.tenantColumn,
            identity: value.tenantIdentity ?? 'tenantId',
          };
    }
    const predicate = backupOwnershipPredicate(ownership(schema), {
      tenantId: this.identity.tenantId,
      tenantKey: tenantKey ?? this.identity.tenantId,
    });
    // tenantKey must not silently fall back when it is actually used as the owner identity.
    const direct = 'parent' in schema ? schema.parent.schema : schema;
    if (direct.tenantIdentity === 'tenantKey' && !tenantKey) throw error();
    await this.assertLive();
    const count = await this.database.queryOne<{ total: number }>(
      `SELECT count(*) AS total FROM "${schema.table}" AS backup_row WHERE ${predicate.sql} AND ${this.guardSql()}`,
      [...predicate.params, ...this.guard()]
    );
    // Restoring a tenant creates new destination-side audit and operational records. Every row
    // from the bundle is still verified separately, but those new records must remain present.
    // Mutable settings, user and admin datasets retain exact cardinality verification.
    const allowsDestinationRows =
      policy.restoreAllowsAdditionalRows === true ||
      APPEND_ONLY_OPERATIONAL_KINDS.has(policy.dataset.kind);
    if (
      !count ||
      count.total < expectedRows ||
      (!allowsDestinationRows && count.total !== expectedRows)
    )
      throw error();
    // Table names come from the trusted registry and were validated above. D1 rejects bound
    // arguments to table-valued PRAGMAs, so this argument must be a trusted SQL literal.
    if (
      await this.database.queryOne(
        `SELECT 1 AS invalid FROM pragma_foreign_key_check('${schema.table}') LIMIT 1`
      )
    )
      throw error();
    await this.assertLive();
  }

  /** Verify consecutive empty datasets with bounded aggregate reads and one live-target window. */
  async verifyEmptyDatasets(policies: readonly SqliteDatasetInspectionPolicy[]): Promise<void> {
    if (!policies.length || policies.length > 4096) throw error();
    const entries = policies.map((policy) => {
      const { schema, tenantKey } = structuredClone({
        schema: policy.schema,
        tenantKey: policy.restoreTenantKey ?? policy.tenantKey,
      });
      if (!/^[a-z][a-z0-9_]*$/.test(schema.table)) throw error();
      function ownership(value: typeof schema): BackupRowOwnership {
        if ('parent' in value)
          return {
            kind: 'parent',
            table: value.parent.schema.table,
            keys: value.parent.schema.primaryKey.map((parent, index) => ({
              parent,
              child: value.parent.childColumns[index],
            })),
            ownership: ownership(value.parent.schema),
          };
        return value.scopeTypeColumn
          ? { kind: 'scope', typeColumn: value.scopeTypeColumn, idColumn: value.tenantColumn }
          : {
              kind: 'tenant',
              column: value.tenantColumn,
              identity: value.tenantIdentity ?? 'tenantId',
            };
      }
      const direct = 'parent' in schema ? schema.parent.schema : schema;
      if (direct.tenantIdentity === 'tenantKey' && !tenantKey) throw error();
      const predicate = backupOwnershipPredicate(ownership(schema), {
        tenantId: this.identity.tenantId,
        tenantKey: tenantKey ?? this.identity.tenantId,
      });
      return {
        datasetId: policy.dataset.id,
        table: schema.table,
        predicate,
        allowsDestinationRows:
          policy.restoreAllowsAdditionalRows === true ||
          APPEND_ONLY_OPERATIONAL_KINDS.has(policy.dataset.kind),
      };
    });
    if (
      new Set(entries.map(({ datasetId }) => datasetId)).size !== entries.length ||
      new Set(entries.map(({ table }) => table)).size !== entries.length
    )
      throw error();
    await this.assertLive();
    const exactEntries = entries.filter(({ allowsDestinationRows }) => !allowsDestinationRows);
    // D1 applies a very small compound-SELECT limit here, including SELECTs introduced by
    // ownership predicates. Scalar subqueries keep each group to one bounded database read.
    for (let offset = 0; offset < exactEntries.length; offset += 50) {
      const group = exactEntries.slice(offset, offset + 50);
      const params: unknown[] = [];
      const columns = group.map((entry, index) => {
        params.push(...entry.predicate.params);
        return `(SELECT count(*) FROM "${entry.table}" AS backup_row WHERE ${entry.predicate.sql}) AS "c${index}"`;
      });
      const counts = await this.database.queryOne<Record<string, number>>(
        `SELECT ${columns.join(',')}`,
        params
      );
      if (!counts || group.some((_, index) => counts[`c${index}`] !== 0)) throw error();
    }
    for (let offset = 0; offset < entries.length; offset += 50) {
      const group = entries.slice(offset, offset + 50);
      const failures = await this.database.queryOne<Record<string, number>>(
        `SELECT ${group
          .map(
            ({ table }, index) =>
              `EXISTS(SELECT 1 FROM pragma_foreign_key_check('${table}')) AS "f${index}"`
          )
          .join(',')}`
      );
      if (!failures || group.some((_, index) => failures[`f${index}`] !== 0)) throw error();
    }
    await this.assertLive();
  }
  /** Freeze this target against further importer writes; this is not application activation. */
  async seal(): Promise<void> {
    if (this.mode === 'verify') throw error();
    await this.authorize();
    const result = await this.database.execute(
      `UPDATE tenant_backup_restore_targets SET state='sealed'
      WHERE ${SEALABLE_GUARD} AND id=?`,
      [...this.guard(), this.identity.id]
    );
    if (!result.success || result.rowsAffected !== 1) throw error();
    if (!(await this.database.queryOne(`SELECT 1 AS sealed WHERE ${SEALED_GUARD}`, this.guard())))
      throw error();
    await this.authorize();
  }
}
